/**
 * StoryCreator — fullscreen story capture + editing experience
 *
 * Camera: 9:16 portrait frame (industry standard for stories).
 * Zoom: 0.5×, 1×, 3× with hardware MediaStream zoom where available,
 *       CSS digital zoom (scale) as universal fallback.
 * Vibes: 8-option manual picker + auto-detect from dominant image colour.
 * Editing: text overlays, freehand draw, 7 CSS filter presets, vibe badge.
 * Post: inline caption + privacy toggle + follower sheet, all fullscreen.
 */

import { useState, useRef, useEffect, useCallback, useReducer } from "react";
import {
  X, RefreshCw, Zap, ZapOff, Type, Check, Pencil,
  Sparkles, Globe, Lock, Users, Send, ImageIcon, ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, ensureCsrfToken, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { User } from "@shared/schema";

// ─── design tokens ───────────────────────────────────────────────────────────

/** Easing curves per Emil Kowalski's framework */
const E = {
  out:    "cubic-bezier(0.23, 1, 0.32, 1)",
  inOut:  "cubic-bezier(0.77, 0, 0.175, 1)",
  drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
} as const;

// ─── constants ────────────────────────────────────────────────────────────────

const FILTERS = [
  { name: "None",  css: "" },
  { name: "Vivid", css: "saturate(1.9) contrast(1.1) brightness(1.05)" },
  { name: "Fade",  css: "contrast(0.82) saturate(0.65) brightness(1.12)" },
  { name: "Noir",  css: "grayscale(1) contrast(1.25) brightness(0.95)" },
  { name: "Warm",  css: "sepia(0.45) saturate(1.4) brightness(1.05)" },
  { name: "Cool",  css: "hue-rotate(18deg) saturate(1.25) brightness(0.96)" },
  { name: "Retro", css: "sepia(0.55) contrast(1.1) brightness(0.88) saturate(0.75)" },
];

/** All selectable vibes — also the auto-detect palette */
const VIBES = [
  { mood: "Fire",     emoji: "🔥", color: "#FF6B35", glow: "rgba(255,107,53,0.45)"  },
  { mood: "Electric", emoji: "⚡", color: "#FFD700", glow: "rgba(255,215,0,0.4)"    },
  { mood: "Hype",     emoji: "🎯", color: "#FF4081", glow: "rgba(255,64,129,0.4)"   },
  { mood: "Vibe",     emoji: "💫", color: "#C4B0FF", glow: "rgba(196,176,255,0.4)"  },
  { mood: "Chill",    emoji: "✨", color: "#7BB8E8", glow: "rgba(123,184,232,0.4)"  },
  { mood: "Dreamy",   emoji: "🌙", color: "#9B89C4", glow: "rgba(155,137,196,0.4)"  },
  { mood: "Fresh",    emoji: "🌿", color: "#4CAF7D", glow: "rgba(76,175,125,0.4)"   },
  { mood: "Pure",     emoji: "🤍", color: "#B8D4E8", glow: "rgba(184,212,232,0.35)" },
] as const;

type VibeMood = (typeof VIBES)[number]["mood"];

const DRAW_COLORS = ["#FFFFFF", "#FF6B6B", "#FFD700", "#4ECDC4", "#C4B0FF", "#000000"];
const DRAW_SIZES  = [4, 8, 16, 24];
const TEXT_COLORS = ["#FFFFFF", "#C4B0FF", "#7BB8E8", "#FFD700", "#FF6B6B", "#4ECDC4", "#000000"];
const FONT_SIZES  = [24, 32, 48, 64];

const ZOOM_LEVELS = [0.5, 1, 3] as const;
type ZoomLevel = typeof ZOOM_LEVELS[number];

const MAX_RECORD_MS = 30_000;
const RING_R = 34;
const RING_C = 2 * Math.PI * RING_R;

/** CSS scale multiplier for digital zoom fallback */
const CSS_SCALE: Record<ZoomLevel, number> = { 0.5: 0.9, 1: 1, 3: 2.6 };

// ─── types ────────────────────────────────────────────────────────────────────

interface TextOverlay {
  id: string;
  text: string;
  x: number; // % of frame
  y: number;
  fontSize: number;
  color: string;
}

interface VibeTagData {
  mood: VibeMood;
  emoji: string;
  color: string;
  glow: string;
  x: number;
  y: number;
}

type ActiveTool = "none" | "text" | "draw" | "filter" | "vibe";
type Phase      = "camera" | "editing";
type MediaKind  = "photo" | "video";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function detectVibeMood(dataUrl: string): Promise<VibeMood> {
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
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if      (r > b + 40 && r > g + 15)       resolve("Fire");
      else if (r > b + 20 && sat > 60)          resolve("Hype");
      else if (b > r + 25 && b > g + 10)        resolve("Chill");
      else if (g > r + 20 && g > b + 20)        resolve("Fresh");
      else if (sat < 30)                         resolve("Pure");
      else if (b > r - 10 && sat > 40)           resolve("Dreamy");
      else                                       resolve("Vibe");
    };
    img.onerror = () => resolve("Vibe");
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

// ─── framer variants ──────────────────────────────────────────────────────────

const sheetVariants = {
  hidden: { y: "100%", transition: { duration: 0.22, ease: E.inOut } },
  show:   { y: 0,      transition: { duration: 0.35, ease: E.drawer } },
};

const panelVariants = {
  hidden: { y: 60, opacity: 0, transition: { duration: 0.18, ease: E.inOut } },
  show:   { y: 0,  opacity: 1, transition: { duration: 0.28, ease: E.out   } },
};

const vibeGridVariants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
};

const vibeItemVariants = {
  hidden: { opacity: 0, scale: 0.88, y: 10 },
  show:   { opacity: 1, scale: 1,    y: 0,  transition: { duration: 0.25, ease: E.out } },
};

// ─── component ────────────────────────────────────────────────────────────────

interface StoryCreatorProps {
  open: boolean;
  onClose: () => void;
  onCreateStory?: (type: "image" | "text", content: string) => void;
}

export default function StoryCreator({ open, onClose }: StoryCreatorProps) {
  const { toast }        = useToast();
  const reducedMotion    = useReducedMotion();

  // phase ────────────────────────────────────────────────────────────────────
  const [phase, setPhase]         = useState<Phase>("camera");
  const [mediaKind, setMediaKind] = useState<MediaKind>("photo");

  // camera ───────────────────────────────────────────────────────────────────
  const [facingMode, setFacingMode]     = useState<"user" | "environment">("user");
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [cameraError, setCameraError]   = useState<string | null>(null);
  const [zoomLevel, setZoomLevel]       = useState<ZoomLevel>(1);
  const [hwZoomCaps, setHwZoomCaps]     = useState<{ min: number; max: number } | null>(null);
  const [showFlash, setShowFlash]       = useState(false);

  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // recording ────────────────────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const recordChunksRef   = useRef<Blob[]>([]);
  const recordTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordStartRef    = useRef(0);

  // captured media ───────────────────────────────────────────────────────────
  const [capturedImage, setCapturedImage]         = useState<string | null>(null);
  const [capturedVideoUrl, setCapturedVideoUrl]   = useState<string | null>(null);
  const [capturedVideoBlob, setCapturedVideoBlob] = useState<Blob | null>(null);

  // editing tools ────────────────────────────────────────────────────────────
  const [activeTool, setActiveTool]         = useState<ActiveTool>("none");
  const [selectedFilter, setSelectedFilter] = useState(0);

  // text overlays
  const [textOverlays, setTextOverlays]     = useState<TextOverlay[]>([]);
  const [isAddingText, setIsAddingText]     = useState(false);
  const [newTextValue, setNewTextValue]     = useState("");
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [textColor, setTextColor]           = useState(TEXT_COLORS[0]);
  const [textFontSize, setTextFontSize]     = useState(32);

  // draw
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [drawSize, setDrawSize]   = useState(DRAW_SIZES[1]);
  const drawCanvasRef   = useRef<HTMLCanvasElement>(null);
  const isDrawingRef    = useRef(false);
  const lastPtRef       = useRef({ x: 0, y: 0 });
  const hasDrawingRef   = useRef(false);

  // vibe
  const [vibeTag, setVibeTag]                   = useState<VibeTagData | null>(null);
  const [isAnalyzingVibe, setIsAnalyzingVibe]   = useState(false);

  // posting ──────────────────────────────────────────────────────────────────
  const [caption, setCaption]               = useState("");
  const [privacy, setPrivacy]               = useState<"public" | "private">("public");
  const [selectedViewers, setSelectedViewers] = useState<string[]>([]);
  const [showViewerSheet, setShowViewerSheet] = useState(false);
  const [isPosting, setIsPosting]           = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // refs ─────────────────────────────────────────────────────────────────────
  const frameRef      = useRef<HTMLDivElement>(null); // the 9:16 media frame
  const captureCanvas = useRef<HTMLCanvasElement>(null);
  const galleryInput  = useRef<HTMLInputElement>(null);
  const dragOffset    = useRef({ x: 0, y: 0 });

  // ─── queries ──────────────────────────────────────────────────────────────

  const { data: followers } = useQuery<Array<{ follower: User }>>({
    queryKey: ["/api/followers"],
    enabled: privacy === "private" && open,
  });

  const createStoryMutation = useMutation({
    mutationFn: async (payload: {
      imageUrl: string; videoUrl?: string; type: string;
      privacy: string; caption?: string; allowedViewerIds?: string[];
    }) => apiRequest("POST", "/api/stories", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stories"] });
      toast({ title: "Story posted!", description: privacy === "private" ? "Shared with selected viewers." : "Shared with everyone." });
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
    setHwZoomCaps(null);
    streamRef.current?.getTracks().forEach(t => t.stop());

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera not available. Use the gallery button to upload.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1080 }, height: { ideal: 1920 }, aspectRatio: { ideal: 9/16 } },
        audio: false,
      });
      streamRef.current = stream;

      // detect hardware zoom capability
      const track = stream.getVideoTracks()[0];
      const caps  = track.getCapabilities?.() as any;
      if (caps?.zoom) {
        setHwZoomCaps({ min: caps.zoom.min, max: caps.zoom.max });
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err: any) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setCameraError("Camera permission denied. Allow camera access in your browser settings.");
      } else if (err.name === "NotFoundError") {
        setCameraError("No camera found. Use the gallery button below.");
      } else if (err.name === "OverconstrainedError") {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          streamRef.current = s;
          if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play(); }
        } catch { setCameraError("Unable to access camera. Use the gallery button."); }
      } else {
        setCameraError("Unable to access camera. Please check permissions.");
      }
    }
  }, [facingMode]);

  useEffect(() => {
    if (open && phase === "camera") startCamera();
    return () => { if (!open) stopCamera(); };
  }, [open, phase, startCamera, stopCamera]);

  // ─── zoom ─────────────────────────────────────────────────────────────────

  const applyZoom = async (level: ZoomLevel) => {
    setZoomLevel(level);
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (hwZoomCaps) {
      // Map our three levels linearly across the hardware zoom range
      const { min, max } = hwZoomCaps;
      const target =
        level === 0.5 ? min :
        level === 1   ? min + (max - min) * 0.15 :
                        min + (max - min) * 0.55;
      try { await track.applyConstraints({ advanced: [{ zoom: Math.round(target * 10) / 10 } as any] }); }
      catch { /* device rejected — CSS fallback still applies */ }
    }
  };

  const flipCamera = () => {
    setZoomLevel(1);
    setFacingMode(m => m === "user" ? "environment" : "user");
  };

  const toggleFlash = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    const caps  = track.getCapabilities?.() as any;
    if (caps?.torch) {
      try { await track.applyConstraints({ advanced: [{ torch: !flashEnabled } as any] }); setFlashEnabled(f => !f); }
      catch { toast({ title: "Flash not supported on this device." }); }
    } else {
      toast({ title: "Flash not supported on this device." });
    }
  };

  // ─── capture ──────────────────────────────────────────────────────────────

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
    hasDrawingRef.current = false;

    // Capture flash
    if (!reducedMotion) {
      setShowFlash(true);
      setTimeout(() => setShowFlash(false), 220);
    }

    // Size draw canvas after paint
    requestAnimationFrame(() => {
      if (drawCanvasRef.current && frameRef.current) {
        drawCanvasRef.current.width  = frameRef.current.clientWidth;
        drawCanvasRef.current.height = frameRef.current.clientHeight;
      }
      setPhase("editing");
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
    if (!window.MediaRecorder) { toast({ title: "Video recording not supported in this browser." }); return; }

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9"
               : MediaRecorder.isTypeSupported("video/webm")            ? "video/webm"
               : MediaRecorder.isTypeSupported("video/mp4")             ? "video/mp4"
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
    holdTimerRef.current = setTimeout(() => { holdTimerRef.current = null; startRecording(); }, 280);
  };
  const onShutterUp = () => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; capturePhoto(); }
    else if (isRecording) stopRecording();
  };

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
        hasDrawingRef.current = false;
        requestAnimationFrame(() => {
          if (drawCanvasRef.current && frameRef.current) {
            drawCanvasRef.current.width  = frameRef.current.clientWidth;
            drawCanvasRef.current.height = frameRef.current.clientHeight;
          }
          setPhase("editing");
        });
      };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith("video/")) {
      setCapturedVideoUrl(URL.createObjectURL(file));
      setCapturedVideoBlob(file);
      setMediaKind("video");
      stopCamera();
      setPhase("editing");
    }
  };

  // ─── draw ─────────────────────────────────────────────────────────────────

  const toPt = (e: React.PointerEvent) => {
    const c = drawCanvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  };

  const onDrawStart = (e: React.PointerEvent) => {
    if (activeTool !== "draw") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    isDrawingRef.current = true; hasDrawingRef.current = true;
    const pt  = toPt(e);
    lastPtRef.current = pt;
    const ctx = drawCanvasRef.current!.getContext("2d")!;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, drawSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = drawColor; ctx.fill();
  };

  const onDrawMove = (e: React.PointerEvent) => {
    if (activeTool !== "draw" || !isDrawingRef.current) return;
    const pt  = toPt(e);
    const ctx = drawCanvasRef.current!.getContext("2d")!;
    ctx.beginPath(); ctx.moveTo(lastPtRef.current.x, lastPtRef.current.y); ctx.lineTo(pt.x, pt.y);
    ctx.strokeStyle = drawColor; ctx.lineWidth = drawSize; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
    lastPtRef.current = pt;
  };

  const onDrawEnd = () => { isDrawingRef.current = false; };

  const clearDraw = () => {
    const c = drawCanvasRef.current;
    if (c) { c.getContext("2d")!.clearRect(0, 0, c.width, c.height); hasDrawingRef.current = false; }
  };

  // ─── text ─────────────────────────────────────────────────────────────────

  const addText = () => {
    if (!newTextValue.trim()) return;
    const ov: TextOverlay = { id: Date.now().toString(), text: newTextValue.trim(), x: 50, y: 50, fontSize: textFontSize, color: textColor };
    setTextOverlays(p => [...p, ov]);
    setNewTextValue(""); setIsAddingText(false); setSelectedTextId(ov.id); setActiveTool("none");
  };

  const removeText = (id: string) => {
    setTextOverlays(p => p.filter(t => t.id !== id));
    if (selectedTextId === id) setSelectedTextId(null);
  };

  const dragText = (e: React.MouseEvent | React.TouchEvent, id: string) => {
    e.preventDefault(); setSelectedTextId(id);
    const ov = textOverlays.find(t => t.id === id);
    if (!ov || !frameRef.current) return;
    const rect = frameRef.current.getBoundingClientRect();
    const cx = "touches" in e ? e.touches[0].clientX : e.clientX;
    const cy = "touches" in e ? e.touches[0].clientY : e.clientY;
    dragOffset.current = { x: cx - rect.left - (ov.x / 100) * rect.width, y: cy - rect.top - (ov.y / 100) * rect.height };

    const move = (ev: MouseEvent | TouchEvent) => {
      const r = frameRef.current?.getBoundingClientRect();
      if (!r) return;
      const mx = "touches" in ev ? ev.touches[0].clientX : ev.clientX;
      const my = "touches" in ev ? ev.touches[0].clientY : ev.clientY;
      setTextOverlays(p => p.map(t => t.id === id ? {
        ...t,
        x: Math.max(5, Math.min(95, ((mx - r.left - dragOffset.current.x) / r.width)  * 100)),
        y: Math.max(5, Math.min(95, ((my - r.top  - dragOffset.current.y) / r.height) * 100)),
      } : t));
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      document.removeEventListener("touchmove", move); document.removeEventListener("touchend", up);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    document.addEventListener("touchmove", move); document.addEventListener("touchend", up);
  };

  // ─── vibe ─────────────────────────────────────────────────────────────────

  const selectVibe = (mood: VibeMood) => {
    const v = VIBES.find(x => x.mood === mood)!;
    setVibeTag({ mood: v.mood, emoji: v.emoji, color: v.color, glow: v.glow, x: 50, y: 78 });
    setActiveTool("none");
  };

  const autoDetectVibe = async () => {
    if (!capturedImage) return;
    setIsAnalyzingVibe(true);
    const mood = await detectVibeMood(capturedImage);
    selectVibe(mood);
    setIsAnalyzingVibe(false);
  };

  // ─── compose final image ──────────────────────────────────────────────────

  const composeFinal = (): Promise<string> =>
    new Promise((resolve) => {
      if (!capturedImage) { resolve(""); return; }
      const img = new Image();
      img.onload = () => {
        const iW = img.naturalWidth, iH = img.naturalHeight;
        const ratio = Math.min(1080 / iW, 1920 / iH, 1);
        const canvas = document.createElement("canvas");
        canvas.width  = Math.round(iW * ratio);
        canvas.height = Math.round(iH * ratio);
        const ctx = canvas.getContext("2d")!;

        if (FILTERS[selectedFilter].css) ctx.filter = FILTERS[selectedFilter].css;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        ctx.filter = "none";

        // bake draw strokes
        const dc = drawCanvasRef.current;
        if (dc && hasDrawingRef.current && dc.width > 0 && frameRef.current) {
          const cW = frameRef.current.clientWidth, cH = frameRef.current.clientHeight;
          const imgR = iW / iH, contR = cW / cH;
          let dW: number, dH: number, ox: number, oy: number;
          if (imgR < contR) { dH = cH; dW = cH * imgR; ox = (cW - dW) / 2; oy = 0; }
          else              { dW = cW; dH = cW / imgR; ox = 0; oy = (cH - dH) / 2; }
          ctx.drawImage(dc, ox, oy, dW, dH, 0, 0, canvas.width, canvas.height);
        }

        // bake text overlays
        textOverlays.forEach(ov => {
          const x = (ov.x / 100) * canvas.width, y = (ov.y / 100) * canvas.height;
          const fs = (ov.fontSize / 100) * canvas.width * 0.15;
          ctx.font = `bold ${fs}px 'PT Sans', sans-serif`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.strokeStyle = ov.color === "#FFFFFF" ? "#000" : "#FFF";
          ctx.lineWidth = fs * 0.08; ctx.strokeText(ov.text, x, y);
          ctx.fillStyle = ov.color; ctx.fillText(ov.text, x, y);
        });

        // bake vibe tag
        if (vibeTag) {
          const vx = (vibeTag.x / 100) * canvas.width, vy = (vibeTag.y / 100) * canvas.height;
          const fs = canvas.width * 0.044;
          const label = `${vibeTag.emoji} ${vibeTag.mood}`;
          ctx.font = `bold ${fs}px 'PT Sans', sans-serif`;
          const tw = ctx.measureText(label).width;
          const pad = fs * 0.7, pw = tw + pad * 2, ph = fs + pad * 1.5;
          ctx.fillStyle = vibeTag.color + "BB";
          drawRoundRect(ctx, vx - pw / 2, vy - ph / 2, pw, ph, ph / 2); ctx.fill();
          ctx.fillStyle = "#FFF"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(label, vx, vy);
        }

        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      img.onerror = () => resolve(capturedImage);
      img.src = capturedImage;
    });

  // ─── upload + post ────────────────────────────────────────────────────────

  const uploadVideoBlob = async (blob: Blob): Promise<string> => {
    const res = await apiRequest("POST", "/api/objects/upload");
    const { uploadURL } = await res.json() as { uploadURL: string };
    const csrf = await ensureCsrfToken();
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadURL);
      xhr.setRequestHeader("Content-Type", blob.type || "video/webm");
      xhr.setRequestHeader("x-csrf-token", csrf);
      xhr.upload.onprogress = e => { if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 80)); };
      xhr.onload  = () => xhr.status < 300 ? resolve() : reject(new Error(`${xhr.status}`));
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(blob);
    });
    setUploadProgress(90);
    const aclRes = await apiRequest("PUT", "/api/post-media", { imageURL: uploadURL });
    if (!aclRes.ok) throw new Error("Failed to set media permissions");
    const { objectPath } = await aclRes.json() as { objectPath: string };
    setUploadProgress(100);
    return objectPath;
  };

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
        createStoryMutation.mutate({
          imageUrl: await composeFinal(), type: "image",
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
    setVibeTag(null); setIsAnalyzingVibe(false); setZoomLevel(1); setHwZoomCaps(null);
    setCaption(""); setPrivacy("public"); setSelectedViewers([]); setShowViewerSheet(false);
    setIsPosting(false); setUploadProgress(0); setFlashEnabled(false); setCameraError(null); setShowFlash(false);
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
  const filterCss    = FILTERS[selectedFilter].css || undefined;
  const cssScale     = CSS_SCALE[zoomLevel];
  const canPost      = (mediaKind === "photo" && !!capturedImage) || (mediaKind === "video" && !!capturedVideoBlob);

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <AnimatePresence>
      <motion.div
        initial={reducedMotion ? {} : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reducedMotion ? {} : { opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-[100] bg-[#0A0A0A] flex flex-col items-center justify-center"
      >

        {/* ═══════════════════════════════════════════════════════════════════
            CAMERA PHASE
        ══════════════════════════════════════════════════════════════════════ */}
        {phase === "camera" && (
          <div className="relative w-full h-full flex flex-col">

            {/* top bar — close / flash / flip */}
            <div
              className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 pt-10 pb-8"
              style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.72), transparent)" }}
            >
              <button
                onClick={handleClose}
                className="w-11 h-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center text-white active:scale-95 transition-transform duration-100"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>

              <div className="flex gap-2">
                <button
                  onClick={toggleFlash}
                  className="w-11 h-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center text-white active:scale-95 transition-transform duration-100"
                  aria-label="Toggle flash"
                >
                  {flashEnabled
                    ? <Zap className="h-5 w-5" style={{ color: "#FFD700" }} />
                    : <ZapOff className="h-5 w-5 opacity-70" />
                  }
                </button>
                <button
                  onClick={flipCamera}
                  className="w-11 h-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center text-white active:scale-95 transition-transform duration-100"
                  aria-label="Flip camera"
                >
                  <RefreshCw className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* 9:16 camera frame — centered, never 1:1 */}
            <div className="flex-1 flex items-center justify-center bg-[#0A0A0A]">
              <div
                ref={frameRef}
                className="relative overflow-hidden bg-black"
                style={{ aspectRatio: "9/16", height: "100%", width: "auto", maxWidth: "100%" }}
              >
                {/* live camera preview */}
                <video
                  ref={videoRef}
                  autoPlay playsInline muted
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{
                    filter: filterCss,
                    transform: `${facingMode === "user" ? "scaleX(-1) " : ""}scale(${cssScale})`,
                    transformOrigin: "center",
                    transition: reducedMotion ? "none" : `transform 0.22s ${E.out}`,
                  }}
                />

                {/* recording badge */}
                {isRecording && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-red-600/90 backdrop-blur-sm px-4 py-1.5 rounded-full z-10">
                    <motion.div
                      animate={reducedMotion ? {} : { opacity: [1, 0.3, 1] }}
                      transition={{ repeat: Infinity, duration: 1 }}
                      className="w-2 h-2 rounded-full bg-white"
                    />
                    <span className="text-white text-sm font-semibold tabular-nums tracking-wide">
                      {Math.ceil((MAX_RECORD_MS - recordingMs) / 1000)}s
                    </span>
                  </div>
                )}

                {/* capture flash */}
                <AnimatePresence>
                  {showFlash && (
                    <motion.div
                      initial={{ opacity: 1 }}
                      animate={{ opacity: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.22, ease: E.out }}
                      className="absolute inset-0 bg-white pointer-events-none z-30"
                    />
                  )}
                </AnimatePresence>

                {/* camera error */}
                {cameraError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/92 gap-5 p-8 z-20">
                    <p className="text-white text-center leading-relaxed text-sm max-w-xs">{cameraError}</p>
                    <button
                      onClick={startCamera}
                      className="w-full max-w-xs py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl text-sm font-medium transition-colors"
                    >
                      Try Again
                    </button>
                    <button
                      onClick={() => galleryInput.current?.click()}
                      className="w-full max-w-xs py-3 border border-white/20 text-white rounded-xl text-sm font-medium hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
                    >
                      <ImageIcon className="h-4 w-4" /> Open Gallery
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* bottom controls */}
            <div
              className="absolute bottom-0 left-0 right-0 z-20 pb-10 pt-3"
              style={{ background: "linear-gradient(to top, rgba(0,0,0,0.82), transparent)" }}
            >
              {/* zoom pills — iOS-style */}
              <div className="flex items-center justify-center gap-2 mb-5">
                {ZOOM_LEVELS.map((z) => (
                  <button
                    key={z}
                    onClick={() => applyZoom(z)}
                    className="relative flex items-center justify-center rounded-full font-bold text-sm transition-all select-none"
                    style={{
                      minWidth: 48, minHeight: 36,
                      paddingLeft: 14, paddingRight: 14,
                      backgroundColor: zoomLevel === z ? "rgba(255,215,0,0.2)" : "rgba(0,0,0,0.45)",
                      backdropFilter: "blur(8px)",
                      color: zoomLevel === z ? "#FFD700" : "rgba(255,255,255,0.7)",
                      border: zoomLevel === z ? "1.5px solid rgba(255,215,0,0.6)" : "1.5px solid rgba(255,255,255,0.15)",
                      transform: zoomLevel === z ? "scale(1.1)" : "scale(1)",
                      transition: reducedMotion ? "none" : `all 0.15s ${E.out}`,
                    }}
                    aria-pressed={zoomLevel === z}
                    aria-label={`${z}× zoom`}
                  >
                    {z === 0.5 ? ".5×" : z === 1 ? "1×" : "3×"}
                  </button>
                ))}
              </div>

              {/* shutter row */}
              <div className="flex items-center justify-between px-10">
                {/* gallery */}
                <button
                  onClick={() => galleryInput.current?.click()}
                  className="w-14 h-14 rounded-2xl border border-white/25 bg-white/10 backdrop-blur-sm flex items-center justify-center active:scale-95 transition-transform duration-100"
                  aria-label="Open gallery"
                >
                  <ImageIcon className="h-6 w-6 text-white/80" />
                </button>

                {/* shutter */}
                <div className="relative flex items-center justify-center">
                  {isRecording && (
                    <svg
                      className="absolute -rotate-90"
                      width={84} height={84} viewBox="0 0 84 84"
                      style={{ pointerEvents: "none" }}
                      aria-hidden="true"
                    >
                      <circle cx={42} cy={42} r={RING_R} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={4.5} />
                      <circle
                        cx={42} cy={42} r={RING_R} fill="none" stroke="#FF4D4D" strokeWidth={4.5}
                        strokeDasharray={RING_C}
                        strokeDashoffset={RING_C * (1 - recordingPct / 100)}
                        strokeLinecap="round"
                        style={{ transition: reducedMotion ? "none" : "stroke-dashoffset 0.1s linear" }}
                      />
                    </svg>
                  )}
                  <button
                    onPointerDown={onShutterDown}
                    onPointerUp={onShutterUp}
                    onPointerLeave={onShutterUp}
                    className="w-[72px] h-[72px] rounded-full border-[4.5px] flex items-center justify-center select-none touch-none"
                    style={{
                      borderColor: isRecording ? "#FF4D4D" : "rgba(255,255,255,0.9)",
                      transition: `border-color 0.2s ${E.out}`,
                    }}
                    aria-label={isRecording ? "Stop recording" : "Capture"}
                  >
                    <div
                      style={{
                        width:  isRecording ? 24 : 60,
                        height: isRecording ? 24 : 60,
                        backgroundColor: isRecording ? "#FF4D4D" : "#FFFFFF",
                        borderRadius: isRecording ? 5 : 9999,
                        transition: reducedMotion ? "none" : `all 0.18s ${E.out}`,
                      }}
                    />
                  </button>
                </div>

                {/* filter toggle */}
                <button
                  onClick={() => setActiveTool(t => t === "filter" ? "none" : "filter")}
                  className="w-14 h-14 rounded-2xl flex items-center justify-center active:scale-95 transition-transform duration-100"
                  style={{
                    border: activeTool === "filter" ? "1.5px solid rgba(196,176,255,0.8)" : "1.5px solid rgba(255,255,255,0.25)",
                    backgroundColor: activeTool === "filter" ? "rgba(196,176,255,0.2)" : "rgba(255,255,255,0.08)",
                    backdropFilter: "blur(8px)",
                    transition: `all 0.15s ${E.out}`,
                  }}
                  aria-label="Filters"
                >
                  <Sparkles className="h-6 w-6" style={{ color: activeTool === "filter" ? "#C4B0FF" : "rgba(255,255,255,0.8)" }} />
                </button>
              </div>

              <p className="text-white/30 text-[10px] text-center mt-4 tracking-[0.2em] uppercase">
                Tap · Hold for video
              </p>
            </div>

            {/* camera filter strip */}
            <AnimatePresence>
              {activeTool === "filter" && (
                <motion.div
                  variants={panelVariants} initial="hidden" animate="show" exit="hidden"
                  className="absolute bottom-36 left-0 right-0 z-20"
                >
                  <div
                    className="flex gap-3 px-4 overflow-x-auto pb-1"
                    style={{ scrollbarWidth: "none" } as React.CSSProperties}
                  >
                    {FILTERS.map((f, i) => (
                      <button key={f.name} onClick={() => { setSelectedFilter(i); setActiveTool("none"); }}
                        className="flex-shrink-0 flex flex-col items-center gap-1.5">
                        <div
                          className="w-14 h-14 rounded-xl overflow-hidden"
                          style={{
                            border: selectedFilter === i ? "2px solid #FFF" : "2px solid rgba(255,255,255,0.15)",
                            filter: f.css || undefined,
                            opacity: selectedFilter === i ? 1 : 0.6,
                            backgroundColor: "#444",
                            transition: `all 0.15s ${E.out}`,
                          }}
                        >
                          <div className="w-full h-full bg-gradient-to-br from-[#9B89C4] to-[#4CAF7D]" />
                        </div>
                        <span className="text-[10px] font-medium tracking-wide uppercase"
                          style={{ color: selectedFilter === i ? "#FFF" : "rgba(255,255,255,0.45)" }}>
                          {f.name}
                        </span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            EDITING PHASE
        ══════════════════════════════════════════════════════════════════════ */}
        {phase === "editing" && (
          <div className="relative w-full h-full flex flex-col">

            {/* top bar */}
            <div
              className="absolute top-0 left-0 right-0 z-30 flex items-start justify-between px-3 pt-10 pb-4"
              style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.78), transparent)" }}
            >
              <button
                onClick={handleRetake}
                className="w-11 h-11 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center text-white active:scale-95 transition-transform duration-100"
                aria-label="Retake"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>

              {/* right tool strip (photos only) */}
              {mediaKind === "photo" && (
                <div className="flex flex-col gap-2">
                  {[
                    { tool: "text" as ActiveTool,   icon: <Type    className="h-4.5 w-4.5" />, label: "Text"    },
                    { tool: "draw" as ActiveTool,   icon: <Pencil  className="h-4.5 w-4.5" />, label: "Draw"    },
                    { tool: "filter" as ActiveTool, icon: <Sparkles className="h-4.5 w-4.5" />, label: "Filters" },
                    { tool: "vibe" as ActiveTool,   icon: <Zap     className="h-4.5 w-4.5" />, label: "Vibe"    },
                  ].map(({ tool, icon, label }) => (
                    <button
                      key={tool}
                      onClick={() => {
                        if (tool === "text") { setActiveTool(t => t === "text" ? "none" : "text"); setIsAddingText(true); }
                        else setActiveTool(t => t === tool ? "none" : tool);
                      }}
                      className="w-10 h-10 rounded-full flex items-center justify-center text-white transition-all"
                      style={{
                        backgroundColor: activeTool === tool ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.45)",
                        backdropFilter: "blur(8px)",
                        boxShadow: activeTool === tool ? "0 0 0 2px rgba(255,255,255,0.6)" : "none",
                        transition: `all 0.15s ${E.out}`,
                      }}
                      aria-label={label} aria-pressed={activeTool === tool}
                    >
                      {tool === "vibe" && vibeTag
                        ? <span className="text-sm">{vibeTag.emoji}</span>
                        : icon
                      }
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 9:16 media frame */}
            <div className="flex-1 flex items-center justify-center bg-[#0A0A0A]">
              <div
                ref={frameRef}
                className="relative overflow-hidden bg-black"
                style={{ aspectRatio: "9/16", height: "100%", width: "auto", maxWidth: "100%" }}
              >
                {/* base image */}
                {mediaKind === "photo" && capturedImage && (
                  <img src={capturedImage} alt="Captured" draggable={false}
                    className="absolute inset-0 w-full h-full object-contain select-none"
                    style={{ filter: filterCss }}
                  />
                )}
                {/* base video */}
                {mediaKind === "video" && capturedVideoUrl && (
                  <video src={capturedVideoUrl} autoPlay muted loop playsInline
                    className="absolute inset-0 w-full h-full object-contain"
                    style={{ filter: filterCss }}
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
                    onPointerDown={onDrawStart} onPointerMove={onDrawMove}
                    onPointerUp={onDrawEnd}     onPointerLeave={onDrawEnd}
                  />
                )}

                {/* text overlays */}
                {textOverlays.map(ov => (
                  <div
                    key={ov.id}
                    className={`absolute select-none ${activeTool !== "draw" ? "cursor-move" : "pointer-events-none"} ${selectedTextId === ov.id ? "ring-2 ring-white/50 rounded-lg p-1" : ""}`}
                    style={{
                      left: `${ov.x}%`, top: `${ov.y}%`, transform: "translate(-50%, -50%)",
                      fontSize: ov.fontSize, color: ov.color, fontWeight: "bold",
                      fontFamily: "'PT Sans', sans-serif",
                      textShadow: ov.color === "#FFFFFF" ? "2px 2px 6px rgba(0,0,0,0.9)" : "2px 2px 6px rgba(0,0,0,0.5)",
                      pointerEvents: activeTool === "draw" ? "none" : "auto",
                    }}
                    onMouseDown={e => dragText(e, ov.id)} onTouchStart={e => dragText(e, ov.id)}
                  >
                    {ov.text}
                    {selectedTextId === ov.id && (
                      <button onClick={e => { e.stopPropagation(); removeText(ov.id); }}
                        className="absolute -top-3 -right-3 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center"
                        aria-label="Remove text">
                        <X className="h-3 w-3 text-white" />
                      </button>
                    )}
                  </div>
                ))}

                {/* vibe badge */}
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
                      animate={reducedMotion ? {} : { scale: [1, 1.05, 1] }}
                      transition={{ repeat: Infinity, duration: 2.4, ease: "easeInOut" }}
                      onClick={() => setActiveTool("vibe")}
                      className="relative flex items-center gap-1.5 px-4 py-2 rounded-full text-white font-bold text-sm"
                      style={{
                        backgroundColor: vibeTag.color + "B0",
                        boxShadow: `0 0 20px ${vibeTag.glow}, 0 0 40px ${vibeTag.glow}`,
                        backdropFilter: "blur(6px)",
                        border: `1px solid ${vibeTag.color}50`,
                      }}
                      aria-label="Change vibe"
                    >
                      <span className="text-base">{vibeTag.emoji}</span>
                      <span className="tracking-wide">{vibeTag.mood}</span>
                      <motion.div
                        animate={reducedMotion ? {} : { opacity: [1, 0.2, 1] }}
                        transition={{ repeat: Infinity, duration: 1.6 }}
                        className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: vibeTag.color }}
                      />
                    </motion.button>
                  </div>
                )}
              </div>
            </div>

            {/* ── tool panels & bottom bar ─────────────────────────────────── */}
            <AnimatePresence mode="wait">
              {/* text input */}
              {isAddingText && (
                <motion.div key="text" variants={panelVariants} initial="hidden" animate="show" exit="hidden"
                  className="absolute bottom-0 left-0 right-0 bg-[#111]/96 backdrop-blur-md p-4 pb-8 space-y-3 z-40">
                  <div className="flex gap-2">
                    <input
                      autoFocus value={newTextValue} onChange={e => setNewTextValue(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && addText()}
                      placeholder="Add text to your story…"
                      className="flex-1 bg-white/8 border border-white/15 rounded-xl px-4 py-2.5 text-white placeholder:text-white/30 outline-none text-sm"
                    />
                    <button onClick={addText} disabled={!newTextValue.trim()}
                      className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 font-bold disabled:opacity-30"
                      style={{ backgroundColor: "#C4B0FF", color: "#000" }}>
                      <Check className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex gap-2">
                      {TEXT_COLORS.map(c => (
                        <button key={c} onClick={() => setTextColor(c)}
                          className="w-7 h-7 rounded-full border-2 transition-transform duration-100"
                          style={{ backgroundColor: c, borderColor: textColor === c ? "#FFF" : "transparent", transform: textColor === c ? "scale(1.2)" : "scale(1)" }} />
                      ))}
                    </div>
                    <div className="flex gap-1 ml-auto">
                      {FONT_SIZES.map(s => (
                        <button key={s} onClick={() => setTextFontSize(s)}
                          className="px-2 py-1 rounded-lg text-xs font-medium transition-colors"
                          style={{ backgroundColor: textFontSize === s ? "#C4B0FF" : "rgba(255,255,255,0.12)", color: textFontSize === s ? "#000" : "#FFF" }}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button onClick={() => { setIsAddingText(false); setActiveTool("none"); }}
                    className="w-full text-white/40 text-sm py-0.5">Cancel</button>
                </motion.div>
              )}

              {/* draw controls */}
              {activeTool === "draw" && !isAddingText && (
                <motion.div key="draw" variants={panelVariants} initial="hidden" animate="show" exit="hidden"
                  className="absolute bottom-0 left-0 right-0 bg-[#111]/96 backdrop-blur-md rounded-t-2xl px-4 pt-5 pb-8 z-40 space-y-4">
                  <div className="flex items-center gap-3">
                    <span className="text-white/40 text-xs w-10">Color</span>
                    <div className="flex gap-2 flex-1 justify-between">
                      {DRAW_COLORS.map(c => (
                        <button key={c} onClick={() => setDrawColor(c)}
                          className="w-8 h-8 rounded-full border-2 transition-transform duration-100"
                          style={{ backgroundColor: c, borderColor: drawColor === c ? "#FFF" : "transparent", transform: drawColor === c ? "scale(1.2)" : "scale(1)" }} />
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-white/40 text-xs w-10">Size</span>
                    <div className="flex gap-2 flex-1">
                      {DRAW_SIZES.map(s => (
                        <button key={s} onClick={() => setDrawSize(s)}
                          className="flex-1 h-9 rounded-xl flex items-center justify-center transition-all"
                          style={{ border: drawSize === s ? "1.5px solid #FFF" : "1.5px solid transparent", backgroundColor: drawSize === s ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)" }}>
                          <div className="rounded-full bg-white" style={{ width: Math.max(3, s / 2.2), height: Math.max(3, s / 2.2) }} />
                        </button>
                      ))}
                    </div>
                    <button onClick={clearDraw} className="bg-white/8 border border-white/15 px-3 py-2 rounded-xl text-white/50 text-xs ml-1">Clear</button>
                  </div>
                  <button onClick={() => setActiveTool("none")} className="w-full text-white/40 text-sm py-0.5">Done</button>
                </motion.div>
              )}

              {/* filter strip */}
              {activeTool === "filter" && !isAddingText && (
                <motion.div key="filter" variants={panelVariants} initial="hidden" animate="show" exit="hidden"
                  className="absolute bottom-0 left-0 right-0 bg-[#111]/96 backdrop-blur-md rounded-t-2xl pt-5 pb-8 z-40">
                  <div className="flex gap-3 px-4 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" } as React.CSSProperties}>
                    {FILTERS.map((f, i) => (
                      <button key={f.name} onClick={() => setSelectedFilter(i)}
                        className="flex-shrink-0 flex flex-col items-center gap-1.5">
                        <div className="w-14 h-20 rounded-xl overflow-hidden"
                          style={{ border: selectedFilter === i ? "2px solid #FFF" : "2px solid rgba(255,255,255,0.12)", opacity: selectedFilter === i ? 1 : 0.55, transition: `all 0.15s ${E.out}` }}>
                          {capturedImage
                            ? <img src={capturedImage} alt={f.name} className="w-full h-full object-cover" style={{ filter: f.css || undefined }} />
                            : <div className="w-full h-full bg-gradient-to-br from-[#9B89C4] to-[#4CAF7D]" style={{ filter: f.css || undefined }} />
                          }
                        </div>
                        <span className="text-[10px] font-medium tracking-wide uppercase"
                          style={{ color: selectedFilter === i ? "#FFF" : "rgba(255,255,255,0.4)" }}>{f.name}</span>
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setActiveTool("none")} className="w-full text-white/40 text-sm mt-3 py-0.5">Done</button>
                </motion.div>
              )}

              {/* vibe picker */}
              {activeTool === "vibe" && !isAddingText && (
                <motion.div key="vibe" variants={sheetVariants} initial="hidden" animate="show" exit="hidden"
                  className="absolute bottom-0 left-0 right-0 bg-[#111]/97 backdrop-blur-xl rounded-t-3xl z-40">
                  <div className="pt-3 pb-1 flex justify-center">
                    <div className="w-10 h-1 rounded-full bg-white/20" />
                  </div>
                  <div className="px-5 pt-3 pb-2">
                    <p className="text-white font-semibold text-base">Pick your Vibe</p>
                    <p className="text-white/40 text-xs mt-0.5">Stamp a mood onto your story</p>
                  </div>

                  <motion.div
                    variants={vibeGridVariants} initial="hidden" animate="show"
                    className="grid grid-cols-4 gap-3 px-5 pb-4"
                  >
                    {VIBES.map((v) => {
                      const selected = vibeTag?.mood === v.mood;
                      return (
                        <motion.button
                          key={v.mood}
                          variants={vibeItemVariants}
                          onClick={() => selectVibe(v.mood)}
                          className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-2xl transition-all"
                          style={{
                            backgroundColor: selected ? v.color + "30" : "rgba(255,255,255,0.06)",
                            border: selected ? `1.5px solid ${v.color}80` : "1.5px solid rgba(255,255,255,0.08)",
                            boxShadow: selected ? `0 0 16px ${v.glow}` : "none",
                            transition: `all 0.18s ${E.out}`,
                          }}
                          aria-pressed={selected} aria-label={`${v.mood} vibe`}
                        >
                          <span className="text-2xl leading-none">{v.emoji}</span>
                          <span className="text-[10px] font-semibold tracking-wide"
                            style={{ color: selected ? v.color : "rgba(255,255,255,0.6)" }}>
                            {v.mood.toUpperCase()}
                          </span>
                        </motion.button>
                      );
                    })}
                  </motion.div>

                  <div className="px-5 pb-8 flex gap-3">
                    {/* auto-detect */}
                    <button
                      onClick={autoDetectVibe}
                      disabled={isAnalyzingVibe || !capturedImage}
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl border border-white/15 bg-white/6 text-white/70 text-sm font-medium transition-colors hover:bg-white/10 disabled:opacity-40"
                    >
                      {isAnalyzingVibe
                        ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Detecting…</>
                        : <><Sparkles className="h-4 w-4" /> Auto Detect</>
                      }
                    </button>
                    {/* remove / cancel */}
                    {vibeTag ? (
                      <button onClick={() => { setVibeTag(null); setActiveTool("none"); }}
                        className="px-5 py-3 rounded-2xl bg-red-500/15 border border-red-500/30 text-red-400 text-sm font-medium">
                        Remove
                      </button>
                    ) : (
                      <button onClick={() => setActiveTool("none")}
                        className="px-5 py-3 rounded-2xl bg-white/8 border border-white/12 text-white/50 text-sm font-medium">
                        Cancel
                      </button>
                    )}
                  </div>
                </motion.div>
              )}

              {/* default bottom bar */}
              {activeTool === "none" && !isAddingText && (
                <motion.div key="bar" variants={panelVariants} initial="hidden" animate="show" exit="hidden"
                  className="absolute bottom-0 left-0 right-0 z-30 px-4 pb-8 pt-4"
                  style={{ background: "linear-gradient(to top, rgba(0,0,0,0.88), transparent)" }}>
                  {/* caption */}
                  <div className="mb-4">
                    <input
                      value={caption} onChange={e => setCaption(e.target.value.slice(0, 150))}
                      placeholder="Add a caption…"
                      className="w-full bg-transparent text-white text-sm placeholder:text-white/30 outline-none border-b border-white/15 pb-2"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    {/* privacy */}
                    <button
                      onClick={() => {
                        if (privacy === "public") { setPrivacy("private"); setShowViewerSheet(true); }
                        else { setPrivacy("public"); setSelectedViewers([]); }
                      }}
                      className="flex items-center gap-1.5 rounded-full px-3 py-2.5 text-white text-xs font-medium shrink-0 transition-colors"
                      style={{ backgroundColor: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.12)" }}
                    >
                      {privacy === "public"
                        ? <><Globe className="h-3.5 w-3.5" /> Public</>
                        : <><Lock className="h-3.5 w-3.5" style={{ color: "#FFD700" }} /> {selectedViewers.length > 0 ? `${selectedViewers.length} viewers` : "Private"}</>
                      }
                    </button>

                    {/* post */}
                    <button
                      onClick={handlePost}
                      disabled={!canPost || isPosting || createStoryMutation.isPending}
                      className="flex-1 flex items-center justify-center gap-2 rounded-full py-3 font-bold text-sm transition-all active:scale-95 disabled:opacity-40"
                      style={{
                        backgroundColor: "#C4B0FF",
                        color: "#0A0A0A",
                        transition: `all 0.12s ${E.out}`,
                      }}
                    >
                      {isPosting ? (
                        <><div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin" />{uploadProgress > 0 ? `${uploadProgress}%` : "Uploading…"}</>
                      ) : createStoryMutation.isPending ? (
                        <><div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin" />Posting…</>
                      ) : (
                        <><Send className="h-4 w-4" />Your Story</>
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
                  variants={sheetVariants} initial="hidden" animate="show" exit="hidden"
                  className="absolute inset-0 z-50 bg-[#0F0F0F] flex flex-col"
                >
                  <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
                    <div>
                      <h3 className="text-white font-semibold">Who can see this?</h3>
                      <p className="text-white/40 text-xs mt-0.5">Select specific followers</p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => setShowViewerSheet(false)} className="text-white hover:bg-white/10">
                      <X className="h-5 w-5" />
                    </Button>
                  </div>
                  <div className="flex gap-4 px-5 py-2.5 border-b border-white/5">
                    <button onClick={() => setSelectedViewers(followers?.map(f => f.follower.id) ?? [])} className="text-sm font-medium" style={{ color: "#C4B0FF" }}>Select All</button>
                    <button onClick={() => setSelectedViewers([])} className="text-white/40 text-sm">Clear</button>
                  </div>
                  <ScrollArea className="flex-1">
                    {followers && followers.length > 0 ? (
                      <div className="px-5 pb-6">
                        {followers.map(({ follower }) => (
                          <div
                            key={follower.id}
                            className="flex items-center gap-3 py-3.5 cursor-pointer border-b border-white/5 last:border-0"
                            onClick={() => setSelectedViewers(p =>
                              p.includes(follower.id) ? p.filter(id => id !== follower.id) : [...p, follower.id]
                            )}
                          >
                            <Checkbox checked={selectedViewers.includes(follower.id)}
                              className="border-white/25 data-[state=checked]:bg-[#C4B0FF] data-[state=checked]:border-[#C4B0FF]" />
                            <Avatar className="h-9 w-9 shrink-0">
                              <AvatarFallback className="text-sm font-semibold" style={{ backgroundColor: "rgba(196,176,255,0.15)", color: "#C4B0FF" }}>
                                {(follower.displayName || follower.username).charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <p className="text-white text-sm font-medium truncate">{follower.displayName || follower.username}</p>
                              <p className="text-white/35 text-xs">@{follower.username}</p>
                            </div>
                            {selectedViewers.includes(follower.id) && <Check className="h-4 w-4 shrink-0" style={{ color: "#C4B0FF" }} />}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center py-16 gap-3" style={{ color: "rgba(255,255,255,0.2)" }}>
                        <Users className="h-12 w-12" />
                        <p className="text-sm">No followers yet</p>
                      </div>
                    )}
                  </ScrollArea>
                  <div className="p-5 border-t border-white/8">
                    <button onClick={() => setShowViewerSheet(false)}
                      className="w-full py-3.5 rounded-2xl font-bold text-sm transition-all active:scale-95"
                      style={{ backgroundColor: "#C4B0FF", color: "#0A0A0A" }}>
                      Done — {selectedViewers.length} selected
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* hidden inputs */}
        <input ref={galleryInput} type="file" accept="image/*,video/*" className="hidden" onChange={handleGallerySelect} />
        <canvas ref={captureCanvas} className="hidden" />
      </motion.div>
    </AnimatePresence>
  );
}
