import type { Express } from "express";
import express from "express";
import crypto from "crypto";
import { storage } from "../storage";
import { requireAuth } from "../middleware";
import { sensitiveOperationLimiter } from "../security";
import { fetchLinkPreview } from "../linkPreviewService";
import { fileTypeFromBuffer } from "file-type";

class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

export function registerMediaRoutes(app: Express): void {
  const largeJsonParser = express.json({ limit: '50mb' });

  // Helper: store base64 data URL in DB, return /api/media/{id} URL
  async function storeMedia(data: string, ownerId: string): Promise<string> {
    const base64Data = data.includes(',') ? data.split(',')[1] : data;
    const buffer = Buffer.from(base64Data, 'base64');

    // fileTypeFromBuffer reads magic bytes — the declared MIME in the data URL
    // is ignored. Any file whose bytes don't parse as image/* or video/* is
    // rejected here, including executables, archives, and spoofed extensions.
    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || (!detected.mime.startsWith('image/') && !detected.mime.startsWith('video/'))) {
      throw new MediaValidationError(
        `File type not allowed: ${detected?.mime ?? 'unknown'}`
      );
    }

    const safeData = `data:${detected.mime};base64,${base64Data}`;
    const id = await storage.saveMedia(safeData, detected.mime, ownerId);
    return `/api/media/${id}`;
  }

  // Generic image upload endpoint for posts/venues (supports multiple images)
  app.post("/api/upload-images", requireAuth, largeJsonParser, async (req, res) => {
    try {
      const { images } = req.body;
      if (!Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ message: "No images provided" });
      }
      if (images.length > 6) {
        return res.status(400).json({ message: "Maximum 6 images allowed per upload" });
      }
      const urls: string[] = [];
      for (const imageData of images) {
        if (!imageData || !imageData.startsWith('data:image')) continue;
        const url = await storeMedia(imageData, req.user!.id);
        urls.push(url);
      }
      res.json({ urls });
    } catch (error) {
      if (error instanceof MediaValidationError) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error uploading images:", error);
      res.status(500).json({ message: "Failed to upload images" });
    }
  });

  app.post("/api/upload-video", requireAuth, largeJsonParser, async (req, res) => {
    try {
      const { videoData } = req.body;
      if (!videoData || !videoData.startsWith('data:video')) {
        return res.status(400).json({ message: "Invalid video data" });
      }
      const videoUrl = await storeMedia(videoData, req.user!.id);
      res.json({ videoUrl });
    } catch (error) {
      if (error instanceof MediaValidationError) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error uploading video:", error);
      res.status(500).json({ message: "Failed to upload video" });
    }
  });

  // Link preview endpoint with SSRF protection and rate limiting
  app.get("/api/link-preview", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const url = req.query.url as string;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ message: "URL parameter is required" });
      }

      if (url.length > 2048) {
        return res.status(400).json({ message: "URL too long" });
      }

      const metadata = await fetchLinkPreview(url);

      if (!metadata) {
        return res.status(404).json({ message: "Could not fetch link preview" });
      }

      res.json(metadata);
    } catch (error) {
      console.error("Link preview error:", error);
      res.status(500).json({ message: "Failed to fetch link preview" });
    }
  });

  app.post("/api/objects/upload", requireAuth, async (req, res) => {
    const tempId = crypto.randomUUID();
    res.json({ uploadURL: `/api/media/binary-upload/${tempId}` });
  });

  // Serve uploaded objects (legacy /objects/ paths — fallback to 404)
  app.get("/objects/:objectPath(*)", async (req, res) => {
    return res.sendStatus(404);
  });

  // Receives raw binary from VideoUploader XHR (replaces GCS presigned PUT)
  const tempBinaryStore = new Map<string, { buffer: Buffer; contentType: string }>();

  app.put("/api/media/binary-upload/:tempId", requireAuth, express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
    try {
      const contentType = req.headers['content-type'] || 'video/mp4';
      tempBinaryStore.set(req.params.tempId, { buffer: req.body as Buffer, contentType });
      // Clean up after 5 minutes
      setTimeout(() => tempBinaryStore.delete(req.params.tempId), 5 * 60 * 1000);
      res.sendStatus(200);
    } catch {
      res.sendStatus(500);
    }
  });

  // Set ACL policy for post media and get normalized path
  app.put("/api/post-media", requireAuth, async (req, res) => {
    try {
      const { imageURL } = req.body;
      if (!imageURL) return res.status(400).json({ message: "imageURL is required" });
      // imageURL is now either a /api/media/binary-upload/{tempId} or a real URL
      const tempIdMatch = imageURL.match(/\/api\/media\/binary-upload\/([a-f0-9-]+)$/);
      if (tempIdMatch) {
        const tempId = tempIdMatch[1];
        const stored = tempBinaryStore.get(tempId);
        if (!stored) return res.status(404).json({ message: "Upload not found or expired" });
        const base64 = stored.buffer.toString('base64');
        const dataUrl = `data:${stored.contentType};base64,${base64}`;
        const objectPath = await storeMedia(dataUrl, req.user!.id);
        tempBinaryStore.delete(tempId);
        return res.json({ objectPath });
      }
      // Already a real URL — just return it
      res.json({ objectPath: imageURL });
    } catch (error) {
      if (error instanceof MediaValidationError) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error processing media:", error);
      res.status(500).json({ message: "Failed to process post media" });
    }
  });

  app.put("/api/venue-images", requireAuth, async (req, res) => {
    try {
      const { imageURL } = req.body;
      if (!imageURL) return res.status(400).json({ message: "imageURL is required" });
      // Same logic as /api/post-media
      const tempIdMatch = imageURL.match(/\/api\/media\/binary-upload\/([a-f0-9-]+)$/);
      if (tempIdMatch) {
        const tempId = tempIdMatch[1];
        const stored = tempBinaryStore.get(tempId);
        if (!stored) return res.status(404).json({ message: "Upload not found or expired" });
        const base64 = stored.buffer.toString('base64');
        const dataUrl = `data:${stored.contentType};base64,${base64}`;
        const objectPath = await storeMedia(dataUrl, req.user!.id);
        tempBinaryStore.delete(tempId);
        return res.json({ objectPath });
      }
      res.json({ objectPath: imageURL });
    } catch (error) {
      if (error instanceof MediaValidationError) {
        return res.status(400).json({ message: error.message });
      }
      res.status(500).json({ message: "Failed to process venue image" });
    }
  });
}