/**
 * StoryCreator — gallery-based story creation + editing experience
 *
 * Pick: gallery upload (image or video from device).
 * Vibes: 8-option manual picker + auto-detect from dominant image colour.
 * Editing: text overlays, freehand draw, 7 CSS filter presets, vibe badge.
 * Post: inline caption + privacy toggle + follower sheet, all fullscreen.
 */

import { useState, useRef } from "react";

import { Button } from "@/components/ui/button";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, ensureCsrfToken, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { User } from "@shared/schema";
import {
  XIcon, TypeIcon, CheckIcon, PencilIcon, SparklesIcon,
  GlobeIcon, LockIcon, UsersIcon, SendIcon, ImageIcon,
  ChevronLeftIcon, FilmIcon, UploadIcon,
} from "@/components/ui/icons";

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
type Phase      = "pick" | "editing";
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

/** Staggered pick-screen entry — each child staggers 50ms apart */
const pickContainerVariants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.05, delayChildren: 0.08 } },
};

const pickItemVariants = {
  hidden: { opacity: 0, y: 18 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.32, ease: E.out } },
};

// ─── component ────────────────────────────────────────────────────────────────

interface StoryCreatorProps {
  open: boolean;
  onClose: () => void;
  onCreateStory?: (type: "image" | "text", content: string) => void;
}

export default function StoryCreator({ open, onClose }: StoryCreatorProps) {
  const { toast }     = useToast();
  const reducedMotion = useReducedMotion();

  // phase ────────────────────────────────────────────────────────────────────
  const [phase, setPhase]         = useState<Phase>("pick");
  const [mediaKind, setMediaKind] = useState<MediaKind>("photo");

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
  const drawCanvasRef  = useRef<HTMLCanvasElement>(null);
  const isDrawingRef   = useRef(false);
  const lastPtRef      = useRef({ x: 0, y: 0 });
  const hasDrawingRef  = useRef(false);

  // vibe
  const [vibeTag, setVibeTag]                 = useState<VibeTagData | null>(null);
  const [isAnalyzingVibe, setIsAnalyzingVibe] = useState(false);

  // posting ──────────────────────────────────────────────────────────────────
  const [caption, setCaption]                 = useState("");
  const [privacy, setPrivacy]                 = useState<"public" | "private">("public");
  const [selectedViewers, setSelectedViewers] = useState<string[]>([]);
  const [showViewerSheet, setShowViewerSheet] = useState(false);
  const [isPosting, setIsPosting]             = useState(false);
  const [uploadProgress, setUploadProgress]   = useState(0);

  // refs ─────────────────────────────────────────────────────────────────────
  const frameRef     = useRef<HTMLDivElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const dragOffset   = useRef({ x: 0, y: 0 });

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
      toast({
        title: "Story posted!",
        description: privacy === "private" ? "Shared with selected viewers." : "Shared with everyone.",
      });
      handleClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to post story. Please try again.", variant: "destructive" });
      setIsPosting(false);
    },
  });

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
        hasDrawingRef.current = false;
        requestAnimationFrame(() => {
          if (drawCanvasRef.current) {
            drawCanvasRef.current.width  = 1080;
            drawCanvasRef.current.height = 1920;
          }
          setPhase("editing");
        });
      };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith("video/")) {
      setCapturedVideoUrl(URL.createObjectURL(file));
      setCapturedVideoBlob(file);
      setMediaKind("video");
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
    const ov: TextOverlay = {
      id: Date.now().toString(), text: newTextValue.trim(),
      x: 50, y: 50, fontSize: textFontSize, color: textColor,
    };
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

  const dragVibeBadge = (e: React.MouseEvent | React.TouchEvent) => {
    if (activeTool === "draw" || !vibeTag || !frameRef.current) return;
    e.preventDefault();
    const rect = frameRef.current.getBoundingClientRect();
    const cx = "touches" in e ? e.touches[0].clientX : e.clientX;
    const cy = "touches" in e ? e.touches[0].clientY : e.clientY;
    dragOffset.current = { x: cx - rect.left - (vibeTag.x / 100) * rect.width, y: cy - rect.top - (vibeTag.y / 100) * rect.height };
    let didMove = false;

    const move = (ev: MouseEvent | TouchEvent) => {
      ev.preventDefault();
      const r = frameRef.current?.getBoundingClientRect();
      if (!r) return;
      const mx = "touches" in ev ? (ev as TouchEvent).touches[0].clientX : (ev as MouseEvent).clientX;
      const my = "touches" in ev ? (ev as TouchEvent).touches[0].clientY : (ev as MouseEvent).clientY;
      if (!didMove && (Math.abs(mx - cx) > 4 || Math.abs(my - cy) > 4)) didMove = true;
      if (!didMove) return;
      setVibeTag(v => !v ? v : {
        ...v,
        x: Math.max(5, Math.min(95, ((mx - r.left - dragOffset.current.x) / r.width)  * 100)),
        y: Math.max(5, Math.min(95, ((my - r.top  - dragOffset.current.y) / r.height) * 100)),
      });
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      document.removeEventListener("touchmove", move); document.removeEventListener("touchend", up);
      if (!didMove) setActiveTool("vibe");
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    document.addEventListener("touchmove", move, { passive: false }); document.addEventListener("touchend", up);
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

        const targetW = 1080, targetH = 1920;
        const canvas = document.createElement("canvas");
        canvas.width  = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d")!;

        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, targetW, targetH);

        const scale = Math.min(targetW / iW, targetH / iH, 1);
        const scaledW = Math.round(iW * scale);
        const scaledH = Math.round(iH * scale);
        const ox = Math.round((targetW - scaledW) / 2);
        const oy = Math.round((targetH - scaledH) / 2);

        if (FILTERS[selectedFilter].css) ctx.filter = FILTERS[selectedFilter].css;
        ctx.drawImage(img, 0, 0, iW, iH, ox, oy, scaledW, scaledH);
        ctx.filter = "none";

        const dc = drawCanvasRef.current;
        if (dc && hasDrawingRef.current && dc.width > 0) {
          ctx.drawImage(dc, 0, 0, dc.width, dc.height, 0, 0, targetW, targetH);
        }

        textOverlays.forEach(ov => {
          const x = (ov.x / 100) * targetW, y = (ov.y / 100) * targetH;
          const fs = (ov.fontSize / 100) * targetW * 0.15;
          ctx.font = `bold ${fs}px 'PT Sans', sans-serif`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.strokeStyle = ov.color === "#FFFFFF" ? "#000" : "#FFF";
          ctx.lineWidth = fs * 0.08; ctx.strokeText(ov.text, x, y);
          ctx.fillStyle = ov.color; ctx.fillText(ov.text, x, y);
        });

        if (vibeTag) {
          const vx = (vibeTag.x / 100) * targetW, vy = (vibeTag.y / 100) * targetH;
          const fs = targetW * 0.044;
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
    setPhase("pick"); setMediaKind("photo");
    setCapturedImage(null);
    if (capturedVideoUrl) URL.revokeObjectURL(capturedVideoUrl);
    setCapturedVideoUrl(null); setCapturedVideoBlob(null);
    setActiveTool("none"); setSelectedFilter(0);
    setTextOverlays([]); setIsAddingText(false); setNewTextValue(""); setSelectedTextId(null);
    setVibeTag(null); setIsAnalyzingVibe(false);
    setCaption(""); setPrivacy("public"); setSelectedViewers([]); setShowViewerSheet(false);
    setIsPosting(false); setUploadProgress(0);
    clearDraw();
  };

  const handleClose = () => { fullReset(); onClose(); };

  const handleRetake = () => {
    if (capturedVideoUrl) URL.revokeObjectURL(capturedVideoUrl);
    setCapturedImage(null); setCapturedVideoUrl(null); setCapturedVideoBlob(null);
    setActiveTool("none"); setSelectedFilter(0); setTextOverlays([]); setVibeTag(null);
    setCaption(""); setIsPosting(false); clearDraw(); setPhase("pick");
  };

  if (!open) return null;

  // ─── derived ──────────────────────────────────────────────────────────────

  const filterCss = FILTERS[selectedFilter].css || undefined;
  const canPost   = (mediaKind === "photo" && !!capturedImage) || (mediaKind === "video" && !!capturedVideoBlob);

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
            PICK PHASE — gallery upload
        ══════════════════════════════════════════════════════════════════════ */}
        {phase === "pick" && (
          <div className="relative w-full h-full flex flex-col">

            {/* top bar */}
            <div className="absolute top-0 left-0 right-0 z-20 px-5 pt-12 pb-4">
              <button
                onClick={handleClose}
                className="w-11 h-11 rounded-full bg-white/8 border border-white/10 flex items-center justify-center text-white active:scale-95 transition-transform duration-100"
                aria-label="Close"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            {/* center content */}
            <div className="flex-1 flex flex-col items-center justify-center px-8">
              <motion.div
                variants={reducedMotion ? {} : pickContainerVariants}
                initial="hidden"
                animate="show"
                className="w-full max-w-sm flex flex-col items-center gap-8"
              >

                {/* icon stack — image + film overlapping */}
                <motion.div variants={reducedMotion ? {} : pickItemVariants} className="relative">
                  <div
                    className="w-24 h-24 rounded-3xl flex items-center justify-center"
                    style={{
                      background: "linear-gradient(135deg, rgba(196,176,255,0.12) 0%, rgba(123,184,232,0.08) 100%)",
                      border: "1px solid rgba(196,176,255,0.2)",
                    }}
                  >
                    <ImageIcon className="h-10 w-10" style={{ color: "rgba(196,176,255,0.7)" }} />
                  </div>
                  {/* video badge offset */}
                  <div
                    className="absolute -bottom-2 -right-2 w-9 h-9 rounded-xl flex items-center justify-center"
                    style={{
                      background: "rgba(123,184,232,0.15)",
                      border: "1px solid rgba(123,184,232,0.3)",
                      backdropFilter: "blur(8px)",
                    }}
                  >
                    <FilmIcon className="h-4 w-4" style={{ color: "#7BB8E8" }} />
                  </div>
                </motion.div>

                {/* text block */}
                <motion.div variants={reducedMotion ? {} : pickItemVariants} className="text-center space-y-2.5">
                  <h2 className="text-white text-[1.6rem] font-bold tracking-tight leading-tight">
                    Add to Your Story
                  </h2>
                  <p className="text-white/40 text-sm leading-relaxed">
                    Pick a photo or video from your gallery
                  </p>
                </motion.div>

                {/* primary CTA */}
                <motion.div variants={reducedMotion ? {} : pickItemVariants} className="w-full space-y-3">
                  <button
                    onClick={() => galleryInput.current?.click()}
                    className="w-full py-4 rounded-full font-bold text-[0.95rem] text-[#0A0A0A] flex items-center justify-center gap-2.5 active:scale-[0.97] transition-transform"
                    style={{
                      backgroundColor: "#C4B0FF",
                      transition: `transform 0.12s ${E.out}`,
                    }}
                    aria-label="Open gallery"
                  >
                    <UploadIcon className="h-4 w-4" />
                    Choose from Gallery
                  </button>

                  {/* supported formats hint */}
                  <p className="text-white/20 text-xs text-center tracking-wide">
                    Photos · Videos up to 30 seconds
                  </p>
                </motion.div>

              </motion.div>
            </div>

            {/* bottom glow line — visual ground */}
            <div
              className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none"
              style={{ background: "linear-gradient(to top, rgba(196,176,255,0.04), transparent)" }}
            />
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
                aria-label="Back to gallery"
              >
                <ChevronLeftIcon className="h-5 w-5" />
              </button>

              {/* right tool strip (photos only) */}
              {mediaKind === "photo" && (
                <div className="flex flex-col gap-2">
                  {[
                    { tool: "text"   as ActiveTool, icon: <TypeIcon     className="h-4.5 w-4.5" />, label: "Text"    },
                    { tool: "draw"   as ActiveTool, icon: <PencilIcon   className="h-4.5 w-4.5" />, label: "Draw"    },
                    { tool: "filter" as ActiveTool, icon: <SparklesIcon className="h-4.5 w-4.5" />, label: "Filters" },
                    { tool: "vibe"   as ActiveTool, icon: <SparklesIcon className="h-4.5 w-4.5" />, label: "Vibe"    },
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
                  <img src={capturedImage} alt="Selected" draggable={false}
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
                        <XIcon className="h-3 w-3 text-white" />
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
                      cursor: "grab",
                      touchAction: "none",
                    }}
                    onMouseDown={dragVibeBadge}
                    onTouchStart={dragVibeBadge}
                  >
                    <motion.div
                      animate={reducedMotion ? {} : { scale: [1, 1.05, 1] }}
                      transition={{ repeat: Infinity, duration: 2.4, ease: "easeInOut" }}
                      className="relative flex items-center gap-1.5 px-4 py-2 rounded-full text-white font-bold text-sm select-none"
                      style={{
                        backgroundColor: vibeTag.color + "B0",
                        boxShadow: `0 0 20px ${vibeTag.glow}, 0 0 40px ${vibeTag.glow}`,
                        backdropFilter: "blur(6px)",
                        border: `1px solid ${vibeTag.color}50`,
                      }}
                      aria-label="Drag to reposition, tap to change vibe"
                    >
                      <span className="text-base">{vibeTag.emoji}</span>
                      <span className="tracking-wide">{vibeTag.mood}</span>
                      <motion.div
                        animate={reducedMotion ? {} : { opacity: [1, 0.2, 1] }}
                        transition={{ repeat: Infinity, duration: 1.6 }}
                        className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: vibeTag.color }}
                      />
                    </motion.div>
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
                      <CheckIcon className="h-5 w-5" />
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
                    <button
                      onClick={autoDetectVibe}
                      disabled={isAnalyzingVibe || !capturedImage}
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl border border-white/15 bg-white/6 text-white/70 text-sm font-medium transition-colors hover:bg-white/10 disabled:opacity-40"
                    >
                      {isAnalyzingVibe
                        ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Detecting…</>
                        : <><SparklesIcon className="h-4 w-4" /> Auto Detect</>
                      }
                    </button>
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
                        ? <><GlobeIcon className="h-3.5 w-3.5" /> Public</>
                        : <><LockIcon className="h-3.5 w-3.5" style={{ color: "#FFD700" }} /> {selectedViewers.length > 0 ? `${selectedViewers.length} viewers` : "Private"}</>
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
                        <><SendIcon className="h-4 w-4" />Your Story</>
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
                      <XIcon className="h-5 w-5" />
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
                            {selectedViewers.includes(follower.id) && <CheckIcon className="h-4 w-4 shrink-0" style={{ color: "#C4B0FF" }} />}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center py-16 gap-3" style={{ color: "rgba(255,255,255,0.2)" }}>
                        <UsersIcon className="h-12 w-12" />
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

        {/* hidden gallery input */}
        <input ref={galleryInput} type="file" accept="image/*,video/*" className="hidden" onChange={handleGallerySelect} />
      </motion.div>
    </AnimatePresence>
  );
}