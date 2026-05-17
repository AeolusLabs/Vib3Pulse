import { useState, useRef, useEffect, useCallback } from "react";
import {
  X, RefreshCw, Zap, ZapOff, Type, Check, Pencil,
  Sparkles, Globe, Lock, Users, Send, ImageIcon, ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, ensureCsrfToken, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { User } from "@shared/schema";

// ─── constants ────────────────────────────────────────────────────────────────

const FILTERS = [
  { name: "None",  css: "" },
  { name: "Vivid", css: "saturate(1.8) contrast(1.1) brightness(1.05)" },
  { name: "Fade",  css: "contrast(0.85) saturate(0.7) brightness(1.1)" },
  { name: "Noir",  css: "grayscale(1) contrast(1.2)" },
  { name: "Warm",  css: "sepia(0.4) saturate(1.3) brightness(1.05)" },
  { name: "Cool",  css: "hue-rotate(15deg) saturate(1.2) brightness(0.95)" },
  { name: "Retro", css: "sepia(0.5) contrast(1.1) brightness(0.9) saturate(0.8)" },
];

const DRAW_COLORS = ["#FFFFFF", "#FF6B6B", "#FFD700", "#4ECDC4", "#D0BFFF", "#000000"];
const DRAW_SIZES  = [4, 8, 16, 24];
const TEXT_COLORS = ["#FFFFFF", "#D0BFFF", "#B0D0FF", "#FFD700", "#FF6B6B", "#4ECDC4", "#000000"];
const FONT_SIZES  = [24, 32, 48, 64];
const MAX_RECORD_MS = 30_000;
const RING_R = 36;
const RING_C = 2 * Math.PI * RING_R;

// ─── types ────────────────────────────────────────────────────────────────────

interface TextOverlay {
  id: string;
  text: string;
  x: number; // % of container
  y: number;
  fontSize: number;
  color: string;
}

interface VibeTagData {
  mood: string;
  emoji: string;
  color: string;
  x: number;
  y: number;
}

type ActiveTool = "none" | "text" | "draw" | "filter";
type Phase      = "camera" | "editing";
type MediaKind  = "photo" | "video";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function analyzeImageMood(
  dataUrl: string,
): Promise<Pick<VibeTagData, "mood" | "emoji" | "color">> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = 32; c.height = 32;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 32, 32);
      const { data } = ctx.getImageData(0, 0, 32, 32);
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; }
      const n = data.length / 4; r /= n; g /= n; b /= n;
      if (r > b + 35 && r > g + 10)        resolve({ mood: "Fire",  emoji: "🔥", color: "#FF6B35" });
      else if (b > r + 20)                  resolve({ mood: "Chill", emoji: "✨", color: "#7B9ED9" });
      else if (g > r + 15 && g > b + 15)   resolve({ mood: "Fresh", emoji: "🌿", color: "#4CAF50" });
      else                                  resolve({ mood: "Vibe",  emoji: "💫", color: "#D0BFFF" });
    };
    img.onerror = () => resolve({ mood: "Vibe", emoji: "💫", color: "#D0BFFF" });
    img.src = dataUrl;
  });
}

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ─── component ────────────────────────────────────────────────────────────────

interface StoryCreatorProps {
  open: boolean;
  onClose: () => void;
  onCreateStory?: (type: "image" | "text", content: string) => void;
}

export default function StoryCreator({ open, onClose }: StoryCreatorProps) {
  const { toast } = useToast();

  // phase
  const [phase, setPhase]         = useState<Phase>("camera");
  const [mediaKind, setMediaKind] = useState<MediaKind>("photo");

  // camera
  const [facingMode, setFacingMode]   = useState<"user" | "environment">("user");
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [cameraError, setCameraError]   = useState<string | null>(null);
  const videoRef    = useRef<HTMLVideoElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);

  // recording
  const [isRecording, setIsRecording]   = useState(false);
  const [recordingMs, setRecordingMs]   = useState(0);
  const mediaRecorderRef   = useRef<MediaRecorder | null>(null);
  const recordChunksRef    = useRef<Blob[]>([]);
  const recordTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordStartRef     = useRef(0);

  // captured media
  const [capturedImage, setCapturedImage]         = useState<string | null>(null);
  const [capturedVideoUrl, setCapturedVideoUrl]   = useState<string | null>(null);
  const [capturedVideoBlob, setCapturedVideoBlob] = useState<Blob | null>(null);

  // editing
  const [activeTool, setActiveTool]       = useState<ActiveTool>("none");
  const [selectedFilter, setSelectedFilter] = useState(0);

  // text overlays
  const [textOverlays, setTextOverlays]   = useState<TextOverlay[]>([]);
  const [isAddingText, setIsAddingText]   = useState(false);
  const [newTextValue, setNewTextValue]   = useState("");
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [textColor, setTextColor]         = useState(TEXT_COLORS[0]);
  const [textFontSize, setTextFontSize]   = useState(32);

  // draw
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [drawSize, setDrawSize]   = useState(DRAW_SIZES[1]);
  const drawCanvasRef   = useRef<HTMLCanvasElement>(null);
  const isDrawingRef    = useRef(false);
  const lastPtRef       = useRef({ x: 0, y: 0 });
  const hasDrawingRef   = useRef(false);

  // vibe tag
  const [vibeTag, setVibeTag]               = useState<VibeTagData | null>(null);
  const [isAnalyzingVibe, setIsAnalyzingVibe] = useState(false);

  // posting
  const [caption, setCaption]               = useState("");
  const [privacy, setPrivacy]               = useState<"public" | "private">("public");
  const [selectedViewers, setSelectedViewers] = useState<string[]>([]);
  const [showViewerSheet, setShowViewerSheet] = useState(false);
  const [isPosting, setIsPosting]           = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // refs
  const containerRef    = useRef<HTMLDivElement>(null);
  const captureCanvas   = useRef<HTMLCanvasElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const dragOffsetRef   = useRef({ x: 0, y: 0 });

  // ─── queries ──────────────────────────────────────────────────────────────

  const { data: followers } = useQuery<Array<{ follower: User }>>({
    queryKey: ["/api/followers"],
    enabled: privacy === "private" && open,
  });

  const createStoryMutation = useMutation({
    mutationFn: async (payload: {
      imageUrl: string;
      videoUrl?: string;
      type: string;
      privacy: string;
      caption?: string;
      allowedViewerIds?: string[];
    }) => apiRequest("POST", "/api/stories", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stories"] });
      toast({ title: "Story posted! 🎉", description: privacy === "private" ? "Shared with selected viewers." : "Shared with everyone." });
      handleClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to post story. Please try again.", variant: "destructive" });
      setIsPosting(false);
    },
  });

  // ─── camera ───────────────────────────────────────────────────────────────

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera not available. Use the gallery button to upload a photo.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1080 }, height: { ideal: 1920 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err: any) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setCameraError("Camera permission denied. Allow camera access in your browser settings.");
      } else if (err.name === "NotFoundError") {
        setCameraError("No camera found. Use the gallery button to upload a photo.");
      } else if (err.name === "OverconstrainedError") {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          streamRef.current = stream;
          if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        } catch {
          setCameraError("Unable to access camera. Use the gallery button.");
        }
      } else {
        setCameraError("Unable to access camera. Please check permissions.");
      }
    }
  }, [facingMode]);

  useEffect(() => {
    if (open && phase === "camera") startCamera();
    return () => { if (!open) stopCamera(); };
  }, [open, phase, startCamera, stopCamera]);

  const flipCamera = () => setFacingMode(m => m === "user" ? "environment" : "user");

  const toggleFlash = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    const caps = track.getCapabilities?.() as any;
    if (caps?.torch) {
      try {
        await track.applyConstraints({ advanced: [{ torch: !flashEnabled } as any] });
        setFlashEnabled(f => !f);
      } catch { /* no-op */ }
    } else {
      toast({ title: "Flash not supported on this device." });
    }
  };

  // ─── photo capture ────────────────────────────────────────────────────────

  const capturePhoto = () => {
    const video  = videoRef.current;
    const canvas = captureCanvas.current;
    if (!video || !canvas || video.videoWidth === 0) return;

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d")!;

    if (facingMode === "user") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    if (FILTERS[selectedFilter].css) ctx.filter = FILTERS[selectedFilter].css;
    ctx.drawImage(video, 0, 0);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    stopCamera();
    setCapturedImage(dataUrl);
    setMediaKind("photo");
    setPhase("editing");
    hasDrawingRef.current = false;

    requestAnimationFrame(() => {
      if (drawCanvasRef.current && containerRef.current) {
        drawCanvasRef.current.width  = containerRef.current.clientWidth;
        drawCanvasRef.current.height = containerRef.current.clientHeight;
      }
    });
  };

  // ─── video recording ──────────────────────────────────────────────────────

  const stopRecording = useCallback(() => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setIsRecording(false);
    setRecordingMs(0);
  }, []);

  const startRecording = () => {
    if (!streamRef.current) return;
    if (!window.MediaRecorder) {
      toast({ title: "Video recording not supported in this browser." });
      return;
    }
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : MediaRecorder.isTypeSupported("video/webm") ? "video/webm"
      : MediaRecorder.isTypeSupported("video/mp4")  ? "video/mp4"
      : "";

    recordChunksRef.current = [];
    const recorder = new MediaRecorder(streamRef.current, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = e => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recordChunksRef.current, { type: mime || "video/webm" });
      const url  = URL.createObjectURL(blob);
      setCapturedVideoUrl(url);
      setCapturedVideoBlob(blob);
      setMediaKind("video");
      stopCamera();
      setPhase("editing");
    };
    recorder.start(100);
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
    setRecordingMs(0);
    recordStartRef.current = Date.now();
    recordTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - recordStartRef.current;
      setRecordingMs(elapsed);
      if (elapsed >= MAX_RECORD_MS) stopRecording();
    }, 100);
  };

  const onShutterDown = () => {
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      startRecording();
    }, 300);
  };

  const onShutterUp = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      capturePhoto();
    } else if (isRecording) {
      stopRecording();
    }
  };

  // cleanup on unmount
  useEffect(() => () => {
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    if (holdTimerRef.current)   clearTimeout(holdTimerRef.current);
    if (capturedVideoUrl)       URL.revokeObjectURL(capturedVideoUrl);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── gallery ──────────────────────────────────────────────────────────────

  const handleGallerySelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setCapturedImage(reader.result as string);
        setMediaKind("photo");
        stopCamera();
        setPhase("editing");
        hasDrawingRef.current = false;
        requestAnimationFrame(() => {
          if (drawCanvasRef.current && containerRef.current) {
            drawCanvasRef.current.width  = containerRef.current.clientWidth;
            drawCanvasRef.current.height = containerRef.current.clientHeight;
          }
        });
      };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith("video/")) {
      const url = URL.createObjectURL(file);
      setCapturedVideoUrl(url);
      setCapturedVideoBlob(file);
      setMediaKind("video");
      stopCamera();
      setPhase("editing");
    }
  };

  // ─── draw ─────────────────────────────────────────────────────────────────

  const toPt = (e: React.PointerEvent) => {
    const canvas = drawCanvasRef.current!;
    const rect   = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width  / rect.width),
      y: (e.clientY - rect.top)  * (canvas.height / rect.height),
    };
  };

  const onDrawStart = (e: React.PointerEvent) => {
    if (activeTool !== "draw") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    hasDrawingRef.current = true;
    const pt = toPt(e);
    lastPtRef.current = pt;
    const ctx = drawCanvasRef.current!.getContext("2d")!;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, drawSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = drawColor; ctx.fill();
  };

  const onDrawMove = (e: React.PointerEvent) => {
    if (activeTool !== "draw" || !isDrawingRef.current) return;
    const pt  = toPt(e);
    const ctx = drawCanvasRef.current!.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(lastPtRef.current.x, lastPtRef.current.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.strokeStyle = drawColor; ctx.lineWidth = drawSize;
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
    lastPtRef.current = pt;
  };

  const onDrawEnd = () => { isDrawingRef.current = false; };

  const clearDraw = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawingRef.current = false;
  };

  // ─── text ─────────────────────────────────────────────────────────────────

  const addText = () => {
    if (!newTextValue.trim()) return;
    const ov: TextOverlay = {
      id: Date.now().toString(), text: newTextValue.trim(),
      x: 50, y: 50, fontSize: textFontSize, color: textColor,
    };
    setTextOverlays(p => [...p, ov]);
    setNewTextValue(""); setIsAddingText(false); setSelectedTextId(ov.id);
    setActiveTool("none");
  };

  const removeText = (id: string) => {
    setTextOverlays(p => p.filter(t => t.id !== id));
    if (selectedTextId === id) setSelectedTextId(null);
  };

  const dragText = (e: React.MouseEvent | React.TouchEvent, id: string) => {
    e.preventDefault();
    setSelectedTextId(id);
    const ov   = textOverlays.find(t => t.id === id);
    const cont = containerRef.current;
    if (!ov || !cont) return;
    const rect = cont.getBoundingClientRect();
    const cx = "touches" in e ? e.touches[0].clientX : e.clientX;
    const cy = "touches" in e ? e.touches[0].clientY : e.clientY;
    dragOffsetRef.current = { x: cx - rect.left - (ov.x / 100) * rect.width, y: cy - rect.top - (ov.y / 100) * rect.height };

    const move = (ev: MouseEvent | TouchEvent) => {
      const r  = containerRef.current?.getBoundingClientRect();
      if (!r) return;
      const mx = "touches" in ev ? ev.touches[0].clientX : ev.clientX;
      const my = "touches" in ev ? ev.touches[0].clientY : ev.clientY;
      const nx = ((mx - r.left - dragOffsetRef.current.x) / r.width)  * 100;
      const ny = ((my - r.top  - dragOffsetRef.current.y) / r.height) * 100;
      setTextOverlays(p => p.map(t => t.id === id ? { ...t, x: Math.max(5, Math.min(95, nx)), y: Math.max(5, Math.min(95, ny)) } : t));
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      document.removeEventListener("touchmove", move); document.removeEventListener("touchend", up);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    document.addEventListener("touchmove", move); document.addEventListener("touchend", up);
  };

  // ─── vibe tag ─────────────────────────────────────────────────────────────

  const generateVibe = async () => {
    if (!capturedImage) return;
    setIsAnalyzingVibe(true);
    const mood = await analyzeImageMood(capturedImage);
    setVibeTag({ ...mood, x: 50, y: 80 });
    setIsAnalyzingVibe(false);
  };

  // ─── compose final image ──────────────────────────────────────────────────

  const composeFinal = (): Promise<string> =>
    new Promise((resolve) => {
      if (!capturedImage) { resolve(""); return; }
      const img = new Image();
      img.onload = () => {
        const iW = img.naturalWidth, iH = img.naturalHeight;
        const canvas = document.createElement("canvas");
        // cap at story resolution
        const ratio = Math.min(1080 / iW, 1920 / iH, 1);
        canvas.width  = Math.round(iW * ratio);
        canvas.height = Math.round(iH * ratio);
        const ctx = canvas.getContext("2d")!;

        if (FILTERS[selectedFilter].css) ctx.filter = FILTERS[selectedFilter].css;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        ctx.filter = "none";

        // bake draw strokes
        const dc = drawCanvasRef.current;
        if (dc && hasDrawingRef.current && dc.width > 0 && containerRef.current) {
          const cW = containerRef.current.clientWidth;
          const cH = containerRef.current.clientHeight;
          const imgRatio = iW / iH, contRatio = cW / cH;
          let dW: number, dH: number, ox: number, oy: number;
          if (imgRatio < contRatio) {
            dH = cH; dW = cH * imgRatio; ox = (cW - dW) / 2; oy = 0;
          } else {
            dW = cW; dH = cW / imgRatio; ox = 0; oy = (cH - dH) / 2;
          }
          ctx.drawImage(dc, ox, oy, dW, dH, 0, 0, canvas.width, canvas.height);
        }

        // bake text overlays
        textOverlays.forEach(ov => {
          const x  = (ov.x / 100) * canvas.width;
          const y  = (ov.y / 100) * canvas.height;
          const fs = (ov.fontSize / 100) * canvas.width * 0.15;
          ctx.font          = `bold ${fs}px 'PT Sans', sans-serif`;
          ctx.textAlign     = "center";
          ctx.textBaseline  = "middle";
          ctx.strokeStyle   = ov.color === "#FFFFFF" ? "#000000" : "#FFFFFF";
          ctx.lineWidth     = fs * 0.08;
          ctx.strokeText(ov.text, x, y);
          ctx.fillStyle = ov.color;
          ctx.fillText(ov.text, x, y);
        });

        // bake vibe tag
        if (vibeTag) {
          const vx = (vibeTag.x / 100) * canvas.width;
          const vy = (vibeTag.y / 100) * canvas.height;
          const fs = canvas.width * 0.042;
          const label = `${vibeTag.emoji} ${vibeTag.mood} Vibe`;
          ctx.font = `bold ${fs}px 'PT Sans', sans-serif`;
          const tw = ctx.measureText(label).width;
          const pad = fs * 0.65;
          const pw  = tw + pad * 2, ph = fs + pad * 1.4;
          ctx.fillStyle = vibeTag.color + "CC";
          drawRoundRect(ctx, vx - pw / 2, vy - ph / 2, pw, ph, ph / 2);
          ctx.fill();
          ctx.fillStyle     = "#FFFFFF";
          ctx.textAlign     = "center";
          ctx.textBaseline  = "middle";
          ctx.fillText(label, vx, vy);
        }

        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      img.onerror = () => resolve(capturedImage);
      img.src = capturedImage;
    });

  // ─── upload video blob ────────────────────────────────────────────────────

  const uploadVideoBlob = async (blob: Blob): Promise<string> => {
    const res = await apiRequest("POST", "/api/objects/upload");
    const { uploadURL } = await res.json() as { uploadURL: string };
    const csrf = await ensureCsrfToken();
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadURL);
      xhr.setRequestHeader("Content-Type", blob.type || "video/webm");
      xhr.setRequestHeader("x-csrf-token", csrf);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 80));
      };
      xhr.onload  = () => xhr.status < 300 ? resolve() : reject(new Error(`${xhr.status}`));
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(blob);
    });
    setUploadProgress(90);
    const aclRes = await apiRequest("PUT", "/api/post-media", { imageURL: uploadURL });
    if (!aclRes.ok) throw new Error("Failed to set media permissions");
    const { objectPath } = await aclRes.json() as { objectPath: string };
    setUploadProgress(100);
    return objectPath;
  };

  // ─── post ─────────────────────────────────────────────────────────────────

  const handlePost = async () => {
    if (isPosting || createStoryMutation.isPending) return;
    setIsPosting(true); setUploadProgress(0);
    try {
      if (mediaKind === "video" && capturedVideoBlob) {
        const objectPath = await uploadVideoBlob(capturedVideoBlob);
        createStoryMutation.mutate({
          imageUrl: objectPath, videoUrl: objectPath, type: "video",
          privacy, caption: caption.trim() || undefined,
          allowedViewerIds: privacy === "private" ? selectedViewers : undefined,
        });
      } else if (capturedImage) {
        const final = await composeFinal();
        createStoryMutation.mutate({
          imageUrl: final, type: "image",
          privacy, caption: caption.trim() || undefined,
          allowedViewerIds: privacy === "private" ? selectedViewers : undefined,
        });
      }
    } catch {
      toast({ title: "Upload failed", description: "Please try again.", variant: "destructive" });
      setIsPosting(false);
    }
  };

  // ─── reset ────────────────────────────────────────────────────────────────

  const fullReset = () => {
    setPhase("camera"); setMediaKind("photo");
    setCapturedImage(null);
    if (capturedVideoUrl) URL.revokeObjectURL(capturedVideoUrl);
    setCapturedVideoUrl(null); setCapturedVideoBlob(null);
    setActiveTool("none"); setSelectedFilter(0);
    setTextOverlays([]); setIsAddingText(false); setNewTextValue(""); setSelectedTextId(null);
    setVibeTag(null); setIsAnalyzingVibe(false);
    setCaption(""); setPrivacy("public"); setSelectedViewers([]); setShowViewerSheet(false);
    setIsPosting(false); setUploadProgress(0); setFlashEnabled(false); setCameraError(null);
    clearDraw();
  };

  const handleClose = () => { stopCamera(); fullReset(); onClose(); };

  const handleRetake = () => {
    if (capturedVideoUrl) URL.revokeObjectURL(capturedVideoUrl);
    setCapturedImage(null); setCapturedVideoUrl(null); setCapturedVideoBlob(null);
    setActiveTool("none"); setSelectedFilter(0); setTextOverlays([]); setVibeTag(null);
    setCaption(""); setIsPosting(false); clearDraw(); setPhase("camera");
  };

  if (!open) return null;

  // ─── derived ──────────────────────────────────────────────────────────────

  const recordingPct = Math.min((recordingMs / MAX_RECORD_MS) * 100, 100);
  const filterStyle  = FILTERS[selectedFilter].css ? FILTERS[selectedFilter].css : undefined;
  const canPost = (mediaKind === "photo" && !!capturedImage) || (mediaKind === "video" && !!capturedVideoBlob);

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[100] bg-black flex flex-col"
      >
        {/* ═══════════════════════════════════════════════════════════════════
            CAMERA PHASE
        ══════════════════════════════════════════════════════════════════════ */}
        {phase === "camera" && (
          <>
            {/* top bar */}
            <div
              className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 pt-10 pb-6"
              style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)" }}
            >
              <Button variant="ghost" size="icon" onClick={handleClose} className="text-white hover:bg-white/20">
                <X className="h-6 w-6" />
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" size="icon" onClick={toggleFlash} className="text-white hover:bg-white/20">
                  {flashEnabled ? <Zap className="h-6 w-6 text-yellow-300" /> : <ZapOff className="h-6 w-6" />}
                </Button>
                <Button variant="ghost" size="icon" onClick={flipCamera} className="text-white hover:bg-white/20">
                  <RefreshCw className="h-6 w-6" />
                </Button>
              </div>
            </div>

            {/* live preview — object-contain fixes the zoom bug */}
            <div className="flex-1 relative flex items-center justify-center bg-black overflow-hidden">
              <video
                ref={videoRef}
                autoPlay playsInline muted
                className={`w-full h-full object-contain ${facingMode === "user" ? "scale-x-[-1]" : ""}`}
                style={{ filter: filterStyle }}
              />

              {/* recording timer */}
              {isRecording && (
                <div className="absolute top-20 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-red-600/90 px-4 py-1.5 rounded-full z-10">
                  <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                  <span className="text-white text-sm font-semibold tabular-nums">
                    {Math.ceil((MAX_RECORD_MS - recordingMs) / 1000)}s
                  </span>
                </div>
              )}

              {/* camera error */}
              {cameraError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/92 gap-5 p-8">
                  <p className="text-white text-center leading-relaxed max-w-xs">{cameraError}</p>
                  <Button onClick={startCamera} variant="secondary" className="w-full max-w-xs">Try Again</Button>
                  <Button
                    onClick={() => galleryInputRef.current?.click()}
                    variant="outline"
                    className="w-full max-w-xs border-white/30 text-white hover:bg-white/20"
                  >
                    <ImageIcon className="h-4 w-4 mr-2" /> Open Gallery
                  </Button>
                </div>
              )}
            </div>

            {/* filter strip above shutter */}
            <AnimatePresence>
              {activeTool === "filter" && (
                <motion.div
                  initial={{ y: 60, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 60, opacity: 0 }}
                  className="absolute bottom-32 left-0 right-0 z-20"
                >
                  <div
                    className="flex gap-3 px-4 overflow-x-auto pb-2"
                    style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
                  >
                    {FILTERS.map((f, i) => (
                      <button
                        key={f.name}
                        onClick={() => { setSelectedFilter(i); setActiveTool("none"); }}
                        className={`flex-shrink-0 flex flex-col items-center gap-1.5 transition-opacity ${selectedFilter === i ? "opacity-100" : "opacity-55"}`}
                      >
                        <div
                          className={`w-14 h-14 rounded-xl border-2 overflow-hidden ${selectedFilter === i ? "border-white" : "border-transparent"}`}
                        >
                          <div className="w-full h-full bg-gradient-to-br from-[#D0BFFF] to-[#7B9ED9]" style={{ filter: f.css || undefined }} />
                        </div>
                        <span className="text-white text-[10px] font-medium">{f.name}</span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* bottom controls */}
            <div
              className="absolute bottom-0 left-0 right-0 z-20 pb-12 pt-6"
              style={{ background: "linear-gradient(to top, rgba(0,0,0,0.75), transparent)" }}
            >
              <div className="flex items-center justify-between px-8">
                {/* gallery */}
                <button
                  onClick={() => galleryInputRef.current?.click()}
                  className="w-14 h-14 rounded-2xl border-2 border-white/40 bg-white/10 backdrop-blur-sm flex items-center justify-center active:scale-95 transition-transform"
                  aria-label="Open gallery"
                >
                  <ImageIcon className="h-6 w-6 text-white" />
                </button>

                {/* shutter — tap = photo, hold = video */}
                <div className="relative flex items-center justify-center">
                  {isRecording && (
                    <svg
                      className="absolute -rotate-90"
                      width={92} height={92}
                      viewBox="0 0 92 92"
                      style={{ pointerEvents: "none" }}
                    >
                      <circle cx={46} cy={46} r={RING_R} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={5} />
                      <circle
                        cx={46} cy={46} r={RING_R} fill="none" stroke="#FF6B6B" strokeWidth={5}
                        strokeDasharray={RING_C}
                        strokeDashoffset={RING_C * (1 - recordingPct / 100)}
                        strokeLinecap="round"
                        style={{ transition: "stroke-dashoffset 0.1s linear" }}
                      />
                    </svg>
                  )}
                  <button
                    onPointerDown={onShutterDown}
                    onPointerUp={onShutterUp}
                    onPointerLeave={onShutterUp}
                    className={`w-20 h-20 rounded-full border-[5px] flex items-center justify-center transition-all select-none touch-none active:scale-95 ${isRecording ? "border-red-500" : "border-white"}`}
                    aria-label="Capture"
                  >
                    <div
                      className="rounded-full transition-all duration-200"
                      style={{
                        width:  isRecording ? 28 : 68,
                        height: isRecording ? 28 : 68,
                        backgroundColor: isRecording ? "#FF6B6B" : "#FFFFFF",
                        borderRadius: isRecording ? 6 : 9999,
                      }}
                    />
                  </button>
                </div>

                {/* filter toggle */}
                <button
                  onClick={() => setActiveTool(t => t === "filter" ? "none" : "filter")}
                  className={`w-14 h-14 rounded-2xl border-2 flex items-center justify-center active:scale-95 transition-all ${activeTool === "filter" ? "border-[#D0BFFF] bg-[#D0BFFF]/25" : "border-white/40 bg-white/10 backdrop-blur-sm"}`}
                  aria-label="Filters"
                >
                  <Sparkles className="h-6 w-6 text-white" />
                </button>
              </div>

              <p className="text-white/40 text-[11px] text-center mt-4 tracking-wide">
                TAP FOR PHOTO · HOLD FOR VIDEO
              </p>
            </div>
          </>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            EDITING PHASE
        ══════════════════════════════════════════════════════════════════════ */}
        {phase === "editing" && (
          <>
            {/* top bar */}
            <div
              className="absolute top-0 left-0 right-0 z-30 flex items-start justify-between px-3 pt-10 pb-4"
              style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.75), transparent)" }}
            >
              <Button variant="ghost" size="icon" onClick={handleRetake} className="text-white hover:bg-white/20">
                <ChevronLeft className="h-6 w-6" />
              </Button>

              {/* right tool strip (photos only) */}
              {mediaKind === "photo" && (
                <div className="flex flex-col gap-2">
                  {/* text */}
                  <button
                    onClick={() => { setActiveTool(t => t === "text" ? "none" : "text"); setIsAddingText(true); }}
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${activeTool === "text" ? "bg-white/30 ring-2 ring-white" : "bg-black/40 hover:bg-white/20"}`}
                    aria-label="Add text"
                  >
                    <Type className="h-5 w-5 text-white" />
                  </button>
                  {/* draw */}
                  <button
                    onClick={() => setActiveTool(t => t === "draw" ? "none" : "draw")}
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${activeTool === "draw" ? "bg-white/30 ring-2 ring-white" : "bg-black/40 hover:bg-white/20"}`}
                    aria-label="Draw"
                  >
                    <Pencil className="h-5 w-5 text-white" />
                  </button>
                  {/* filters */}
                  <button
                    onClick={() => setActiveTool(t => t === "filter" ? "none" : "filter")}
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${activeTool === "filter" ? "bg-white/30 ring-2 ring-white" : "bg-black/40 hover:bg-white/20"}`}
                    aria-label="Filters"
                  >
                    <Sparkles className="h-5 w-5 text-white" />
                  </button>
                  {/* vibe tag */}
                  <button
                    onClick={() => vibeTag ? setVibeTag(null) : generateVibe()}
                    disabled={isAnalyzingVibe}
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${vibeTag ? "ring-2 ring-[#D0BFFF] bg-[#D0BFFF]/30" : "bg-black/40 hover:bg-white/20"}`}
                    aria-label="Vibe Tag"
                  >
                    {isAnalyzingVibe
                      ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      : <Zap className="h-5 w-5 text-white" />
                    }
                  </button>
                </div>
              )}
            </div>

            {/* media area */}
            <div
              ref={containerRef}
              className="flex-1 relative flex items-center justify-center bg-black overflow-hidden"
            >
              {/* base image */}
              {mediaKind === "photo" && capturedImage && (
                <img
                  src={capturedImage}
                  alt="Captured"
                  className="w-full h-full object-contain select-none"
                  style={{ filter: filterStyle }}
                  draggable={false}
                />
              )}
              {/* base video */}
              {mediaKind === "video" && capturedVideoUrl && (
                <video
                  src={capturedVideoUrl}
                  className="w-full h-full object-contain"
                  autoPlay muted loop playsInline
                  style={{ filter: filterStyle }}
                />
              )}

              {/* draw canvas (photos only) */}
              {mediaKind === "photo" && (
                <canvas
                  ref={drawCanvasRef}
                  className="absolute inset-0 w-full h-full"
                  style={{
                    touchAction: "none",
                    cursor: activeTool === "draw" ? "crosshair" : "default",
                    pointerEvents: activeTool === "draw" ? "auto" : "none",
                  }}
                  onPointerDown={onDrawStart}
                  onPointerMove={onDrawMove}
                  onPointerUp={onDrawEnd}
                  onPointerLeave={onDrawEnd}
                />
              )}

              {/* text overlays */}
              {textOverlays.map(ov => (
                <div
                  key={ov.id}
                  className={`absolute select-none ${activeTool !== "draw" ? "cursor-move" : "pointer-events-none"} ${selectedTextId === ov.id ? "ring-2 ring-white/50 rounded-lg p-1" : ""}`}
                  style={{
                    left: `${ov.x}%`, top: `${ov.y}%`,
                    transform: "translate(-50%, -50%)",
                    fontSize: ov.fontSize,
                    color: ov.color,
                    fontWeight: "bold",
                    fontFamily: "'PT Sans', sans-serif",
                    textShadow: ov.color === "#FFFFFF"
                      ? "2px 2px 6px rgba(0,0,0,0.9)"
                      : "2px 2px 6px rgba(255,255,255,0.5)",
                    pointerEvents: activeTool === "draw" ? "none" : "auto",
                  }}
                  onMouseDown={e => dragText(e, ov.id)}
                  onTouchStart={e => dragText(e, ov.id)}
                >
                  {ov.text}
                  {selectedTextId === ov.id && (
                    <button
                      onClick={e => { e.stopPropagation(); removeText(ov.id); }}
                      className="absolute -top-3 -right-3 bg-red-500 rounded-full p-0.5"
                    >
                      <X className="h-3 w-3 text-white" />
                    </button>
                  )}
                </div>
              ))}

              {/* vibe tag badge */}
              {vibeTag && (
                <div
                  className="absolute"
                  style={{
                    left: `${vibeTag.x}%`, top: `${vibeTag.y}%`,
                    transform: "translate(-50%, -50%)",
                    pointerEvents: activeTool === "draw" ? "none" : "auto",
                  }}
                >
                  <motion.button
                    animate={{ scale: [1, 1.04, 1] }}
                    transition={{ repeat: Infinity, duration: 2.2, ease: "easeInOut" }}
                    onClick={() => setVibeTag(null)}
                    className="relative flex items-center gap-1.5 px-3.5 py-2 rounded-full text-white font-bold text-sm select-none"
                    style={{
                      backgroundColor: vibeTag.color + "BB",
                      boxShadow: `0 0 18px ${vibeTag.color}66`,
                      backdropFilter: "blur(4px)",
                    }}
                    title="Tap to remove"
                  >
                    <span className="text-base">{vibeTag.emoji}</span>
                    <span>{vibeTag.mood} Vibe</span>
                    <motion.div
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{ repeat: Infinity, duration: 1.5 }}
                      className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: vibeTag.color }}
                    />
                  </motion.button>
                </div>
              )}
            </div>

            {/* ── tool panels & bottom bar ─────────────────────────────────── */}
            <AnimatePresence mode="wait">
              {/* text input */}
              {isAddingText && (
                <motion.div
                  key="text-panel"
                  initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }}
                  className="absolute bottom-0 left-0 right-0 bg-black/95 backdrop-blur-sm p-4 space-y-3 z-40 pb-8"
                >
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      value={newTextValue}
                      onChange={e => setNewTextValue(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && addText()}
                      placeholder="Add text to your story..."
                      className="flex-1 bg-white/10 border border-white/20 rounded-xl px-3 py-2 text-white placeholder:text-white/40 outline-none text-sm"
                    />
                    <button
                      onClick={addText}
                      disabled={!newTextValue.trim()}
                      className="w-10 h-10 rounded-xl bg-[#D0BFFF] disabled:opacity-40 flex items-center justify-center shrink-0"
                    >
                      <Check className="h-5 w-5 text-black" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex gap-2">
                      {TEXT_COLORS.map(c => (
                        <button key={c} onClick={() => setTextColor(c)}
                          className={`w-7 h-7 rounded-full border-2 transition-transform ${textColor === c ? "border-white scale-125" : "border-transparent"}`}
                          style={{ backgroundColor: c }} />
                      ))}
                    </div>
                    <div className="flex gap-1 ml-auto">
                      {FONT_SIZES.map(s => (
                        <button key={s} onClick={() => setTextFontSize(s)}
                          className={`px-2 py-1 rounded-lg text-xs ${textFontSize === s ? "bg-[#D0BFFF] text-black font-bold" : "bg-white/15 text-white"}`}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button onClick={() => { setIsAddingText(false); setActiveTool("none"); }}
                    className="w-full text-white/50 text-sm py-1">Cancel</button>
                </motion.div>
              )}

              {/* draw controls */}
              {activeTool === "draw" && !isAddingText && (
                <motion.div
                  key="draw-panel"
                  initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
                  className="absolute bottom-0 left-0 right-0 bg-black/90 backdrop-blur-sm rounded-t-2xl px-4 pt-4 pb-8 z-40 space-y-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-white/50 text-xs w-12">Color</span>
                    <div className="flex gap-2 flex-1 justify-between">
                      {DRAW_COLORS.map(c => (
                        <button key={c} onClick={() => setDrawColor(c)}
                          className={`w-8 h-8 rounded-full border-2 transition-transform ${drawColor === c ? "border-white scale-125" : "border-transparent"}`}
                          style={{ backgroundColor: c }} />
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-white/50 text-xs w-12">Size</span>
                    <div className="flex gap-2 flex-1">
                      {DRAW_SIZES.map(s => (
                        <button key={s} onClick={() => setDrawSize(s)}
                          className={`flex-1 h-8 rounded-lg flex items-center justify-center border-2 transition-all ${drawSize === s ? "border-white bg-white/20" : "border-transparent bg-white/10"}`}>
                          <div className="rounded-full bg-white" style={{ width: Math.max(3, s / 2.5), height: Math.max(3, s / 2.5) }} />
                        </button>
                      ))}
                    </div>
                    <button onClick={clearDraw} className="bg-white/10 px-3 py-1.5 rounded-lg text-white/60 text-xs ml-2 hover:bg-white/20">
                      Clear
                    </button>
                  </div>
                  <button onClick={() => setActiveTool("none")} className="w-full text-white/50 text-sm py-1">Done</button>
                </motion.div>
              )}

              {/* filter strip */}
              {activeTool === "filter" && !isAddingText && (
                <motion.div
                  key="filter-panel"
                  initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
                  className="absolute bottom-0 left-0 right-0 bg-black/90 backdrop-blur-sm rounded-t-2xl pt-4 pb-8 z-40"
                >
                  <div
                    className="flex gap-3 px-4 overflow-x-auto pb-2"
                    style={{ scrollbarWidth: "none" } as React.CSSProperties}
                  >
                    {FILTERS.map((f, i) => (
                      <button key={f.name} onClick={() => setSelectedFilter(i)}
                        className={`flex-shrink-0 flex flex-col items-center gap-1.5 transition-opacity ${selectedFilter === i ? "opacity-100" : "opacity-55"}`}>
                        <div className={`w-14 h-20 rounded-xl border-2 overflow-hidden ${selectedFilter === i ? "border-white" : "border-transparent"}`}>
                          {capturedImage
                            ? <img src={capturedImage} alt={f.name} className="w-full h-full object-cover" style={{ filter: f.css || undefined }} />
                            : <div className="w-full h-full bg-gradient-to-br from-[#D0BFFF] to-[#7B9ED9]" style={{ filter: f.css || undefined }} />
                          }
                        </div>
                        <span className={`text-[11px] font-medium ${selectedFilter === i ? "text-white" : "text-white/50"}`}>{f.name}</span>
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setActiveTool("none")} className="w-full text-white/50 text-sm py-2">Done</button>
                </motion.div>
              )}

              {/* default bottom bar — caption + privacy + post */}
              {activeTool === "none" && !isAddingText && (
                <motion.div
                  key="action-bar"
                  initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
                  className="absolute bottom-0 left-0 right-0 z-30 px-4 pb-8 pt-3"
                  style={{ background: "linear-gradient(to top, rgba(0,0,0,0.85), transparent)" }}
                >
                  {/* caption */}
                  <div className="mb-3">
                    <input
                      value={caption}
                      onChange={e => setCaption(e.target.value.slice(0, 150))}
                      placeholder="Add a caption..."
                      className="w-full bg-transparent text-white text-sm placeholder:text-white/35 outline-none border-b border-white/20 pb-1.5"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    {/* privacy */}
                    <button
                      onClick={() => {
                        if (privacy === "public") { setPrivacy("private"); setShowViewerSheet(true); }
                        else { setPrivacy("public"); setSelectedViewers([]); }
                      }}
                      className="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 rounded-full px-3 py-2 text-white text-xs font-medium transition-all shrink-0"
                    >
                      {privacy === "public"
                        ? <><Globe className="h-3.5 w-3.5" /> Public</>
                        : <><Lock className="h-3.5 w-3.5 text-amber-400" /> {selectedViewers.length > 0 ? `${selectedViewers.length} viewers` : "Private"}</>
                      }
                    </button>

                    {/* post */}
                    <button
                      onClick={handlePost}
                      disabled={!canPost || isPosting || createStoryMutation.isPending}
                      className="flex-1 flex items-center justify-center gap-2 bg-[#D0BFFF] hover:bg-[#C0AFEF] disabled:opacity-50 text-black font-bold rounded-full py-3 transition-all active:scale-95"
                    >
                      {isPosting ? (
                        <>
                          <div className="w-4 h-4 border-2 border-black/25 border-t-black rounded-full animate-spin" />
                          {uploadProgress > 0 ? `${uploadProgress}%` : "Uploading…"}
                        </>
                      ) : createStoryMutation.isPending ? (
                        <>
                          <div className="w-4 h-4 border-2 border-black/25 border-t-black rounded-full animate-spin" />
                          Posting…
                        </>
                      ) : (
                        <>
                          <Send className="h-4 w-4" />
                          Your Story
                        </>
                      )}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* viewer selection sheet */}
            <AnimatePresence>
              {showViewerSheet && (
                <motion.div
                  initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                  transition={{ type: "spring", damping: 30, stiffness: 300 }}
                  className="absolute inset-0 z-50 bg-[#111] flex flex-col"
                >
                  <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
                    <h3 className="text-white font-semibold">Who can see this?</h3>
                    <Button variant="ghost" size="icon" onClick={() => setShowViewerSheet(false)} className="text-white hover:bg-white/10">
                      <X className="h-5 w-5" />
                    </Button>
                  </div>
                  <div className="flex gap-4 px-4 py-2.5 border-b border-white/5">
                    <button onClick={() => setSelectedViewers(followers?.map(f => f.follower.id) ?? [])} className="text-[#D0BFFF] text-sm font-medium">Select All</button>
                    <button onClick={() => setSelectedViewers([])} className="text-white/40 text-sm">Clear</button>
                  </div>
                  <ScrollArea className="flex-1">
                    {followers && followers.length > 0 ? (
                      <div className="px-4 pb-4">
                        {followers.map(({ follower }) => (
                          <div
                            key={follower.id}
                            className="flex items-center gap-3 py-3 cursor-pointer border-b border-white/5 last:border-0"
                            onClick={() => setSelectedViewers(p =>
                              p.includes(follower.id) ? p.filter(id => id !== follower.id) : [...p, follower.id]
                            )}
                          >
                            <Checkbox
                              checked={selectedViewers.includes(follower.id)}
                              className="border-white/30 data-[state=checked]:bg-[#D0BFFF] data-[state=checked]:border-[#D0BFFF]"
                            />
                            <Avatar className="h-9 w-9">
                              <AvatarFallback className="bg-[#D0BFFF]/20 text-[#D0BFFF] text-sm font-semibold">
                                {(follower.displayName || follower.username).charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <p className="text-white text-sm font-medium truncate">{follower.displayName || follower.username}</p>
                              <p className="text-white/40 text-xs">@{follower.username}</p>
                            </div>
                            {selectedViewers.includes(follower.id) && <Check className="h-4 w-4 text-[#D0BFFF] shrink-0" />}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center py-16 text-white/30 gap-3">
                        <Users className="h-12 w-12" />
                        <p className="text-sm">No followers yet</p>
                      </div>
                    )}
                  </ScrollArea>
                  <div className="p-4 border-t border-white/10">
                    <button
                      onClick={() => setShowViewerSheet(false)}
                      className="w-full bg-[#D0BFFF] hover:bg-[#C0AFEF] text-black font-bold rounded-full py-3 transition-all"
                    >
                      Done ({selectedViewers.length} selected)
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

        {/* hidden inputs */}
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={handleGallerySelect}
        />
        <canvas ref={captureCanvas} className="hidden" />
      </motion.div>
    </AnimatePresence>
  );
}
