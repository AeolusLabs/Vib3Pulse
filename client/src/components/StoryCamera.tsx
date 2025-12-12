import { useState, useRef, useEffect, useCallback } from "react";
import { X, RefreshCw, Zap, ZapOff, Type, Trash2, Check, Move } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "framer-motion";

interface TextOverlay {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  fontStyle: "normal" | "bold" | "italic";
}

interface StoryCameraProps {
  open: boolean;
  onClose: () => void;
  onCapture: (imageDataUrl: string) => void;
  onSwitchToUpload?: () => void;
}

const TEXT_COLORS = [
  "#FFFFFF",
  "#D0BFFF",
  "#B0D0FF", 
  "#FFD700",
  "#FF6B6B",
  "#4ECDC4",
  "#000000",
];

const FONT_SIZES = [24, 32, 48, 64];

export default function StoryCamera({ open, onClose, onCapture, onSwitchToUpload }: StoryCameraProps) {
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>([]);
  const [isAddingText, setIsAddingText] = useState(false);
  const [newTextValue, setNewTextValue] = useState("");
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [selectedColor, setSelectedColor] = useState("#FFFFFF");
  const [selectedFontSize, setSelectedFontSize] = useState(32);
  const [cameraError, setCameraError] = useState<string | null>(null);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  const startCamera = useCallback(async () => {
    try {
      setCameraError(null);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }

      // Check if mediaDevices is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError("Camera not available. Please use the upload option instead, or try on a device with a camera.");
        return;
      }

      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: facingMode,
          width: { ideal: 1080 },
          height: { ideal: 1920 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (error: any) {
      console.error("Error accessing camera:", error);
      
      // Provide specific error messages based on the error type
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        setCameraError("Camera permission denied. Please allow camera access in your browser settings and try again.");
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        setCameraError("No camera found. Please connect a camera or use the upload option instead.");
      } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        setCameraError("Camera is in use by another application. Please close other apps using the camera and try again.");
      } else if (error.name === 'OverconstrainedError') {
        setCameraError("Camera doesn't support the requested settings. Trying with basic settings...");
        // Try with simpler constraints
        try {
          const simpleStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          streamRef.current = simpleStream;
          if (videoRef.current) {
            videoRef.current.srcObject = simpleStream;
            await videoRef.current.play();
          }
          setCameraError(null);
        } catch {
          setCameraError("Unable to access camera. Please use the upload option instead.");
        }
      } else {
        setCameraError("Unable to access camera. Please check permissions or use the upload option instead.");
      }
    }
  }, [facingMode]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (open && !capturedImage) {
      startCamera();
    }
    return () => {
      if (!open) {
        stopCamera();
      }
    };
  }, [open, capturedImage, startCamera, stopCamera]);

  useEffect(() => {
    if (!capturedImage) {
      startCamera();
    }
  }, [facingMode, capturedImage, startCamera]);

  const flipCamera = () => {
    setFacingMode(prev => prev === "user" ? "environment" : "user");
  };

  const toggleFlash = async () => {
    if (streamRef.current) {
      const track = streamRef.current.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.();
      if (capabilities && 'torch' in capabilities) {
        try {
          await track.applyConstraints({
            advanced: [{ torch: !flashEnabled } as MediaTrackConstraintSet]
          });
          setFlashEnabled(!flashEnabled);
        } catch (e) {
          console.log("Flash not supported on this device");
        }
      }
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const ctx = canvas.getContext("2d");
      if (ctx) {
        if (facingMode === "user") {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0);
        
        const imageData = canvas.toDataURL("image/jpeg", 0.9);
        setCapturedImage(imageData);
        stopCamera();
      }
    }
  };

  const retakePhoto = () => {
    setCapturedImage(null);
    setTextOverlays([]);
    setSelectedTextId(null);
    startCamera();
  };

  const addTextOverlay = () => {
    if (newTextValue.trim()) {
      const newOverlay: TextOverlay = {
        id: Date.now().toString(),
        text: newTextValue.trim(),
        x: 50,
        y: 50,
        fontSize: selectedFontSize,
        color: selectedColor,
        fontStyle: "bold",
      };
      setTextOverlays(prev => [...prev, newOverlay]);
      setNewTextValue("");
      setIsAddingText(false);
      setSelectedTextId(newOverlay.id);
    }
  };

  const removeTextOverlay = (id: string) => {
    setTextOverlays(prev => prev.filter(t => t.id !== id));
    if (selectedTextId === id) {
      setSelectedTextId(null);
    }
  };

  const handleTextDragStart = (e: React.MouseEvent | React.TouchEvent, id: string) => {
    e.preventDefault();
    setSelectedTextId(id);
    
    const overlay = textOverlays.find(t => t.id === id);
    if (!overlay || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    const currentX = (overlay.x / 100) * containerRect.width;
    const currentY = (overlay.y / 100) * containerRect.height;
    
    dragOffsetRef.current = {
      x: clientX - containerRect.left - currentX,
      y: clientY - containerRect.top - currentY,
    };

    const handleMove = (moveEvent: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;
      
      const moveClientX = 'touches' in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
      const moveClientY = 'touches' in moveEvent ? moveEvent.touches[0].clientY : moveEvent.clientY;
      
      const rect = containerRef.current.getBoundingClientRect();
      const x = ((moveClientX - rect.left - dragOffsetRef.current.x) / rect.width) * 100;
      const y = ((moveClientY - rect.top - dragOffsetRef.current.y) / rect.height) * 100;
      
      setTextOverlays(prev => prev.map(t => 
        t.id === id ? { ...t, x: Math.max(5, Math.min(95, x)), y: Math.max(5, Math.min(95, y)) } : t
      ));
    };

    const handleEnd = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleMove);
    document.addEventListener('touchend', handleEnd);
  };

  const composeFinalImage = (): Promise<string> => {
    return new Promise((resolve) => {
      if (!capturedImage) {
        resolve("");
        return;
      }

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          
          textOverlays.forEach(overlay => {
            const x = (overlay.x / 100) * canvas.width;
            const y = (overlay.y / 100) * canvas.height;
            const scaledFontSize = (overlay.fontSize / 100) * canvas.width * 0.15;
            
            ctx.font = `${overlay.fontStyle === "bold" ? "bold" : overlay.fontStyle === "italic" ? "italic" : ""} ${scaledFontSize}px 'PT Sans', sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            
            ctx.strokeStyle = overlay.color === "#FFFFFF" ? "#000000" : "#FFFFFF";
            ctx.lineWidth = scaledFontSize * 0.08;
            ctx.strokeText(overlay.text, x, y);
            
            ctx.fillStyle = overlay.color;
            ctx.fillText(overlay.text, x, y);
          });
          
          resolve(canvas.toDataURL("image/jpeg", 0.9));
        }
      };
      img.src = capturedImage;
    });
  };

  const handleConfirm = async () => {
    const finalImage = await composeFinalImage();
    onCapture(finalImage);
    setCapturedImage(null);
    setTextOverlays([]);
    setSelectedTextId(null);
  };

  const handleClose = () => {
    stopCamera();
    setCapturedImage(null);
    setTextOverlays([]);
    setSelectedTextId(null);
    onClose();
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] bg-black"
        data-testid="story-camera-fullscreen"
      >
        <div className="relative w-full h-full flex flex-col">
          <div 
            className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between p-4"
            style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)" }}
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClose}
              className="text-white hover:bg-white/20"
              data-testid="button-close-camera"
            >
              <X className="h-6 w-6" />
            </Button>
            
            {!capturedImage && (
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleFlash}
                  className="text-white hover:bg-white/20"
                  data-testid="button-toggle-flash"
                >
                  {flashEnabled ? <Zap className="h-6 w-6 text-yellow-400" /> : <ZapOff className="h-6 w-6" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={flipCamera}
                  className="text-white hover:bg-white/20"
                  data-testid="button-flip-camera"
                >
                  <RefreshCw className="h-6 w-6" />
                </Button>
              </div>
            )}
            
            {capturedImage && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsAddingText(true)}
                className="text-white hover:bg-white/20"
                data-testid="button-add-text"
              >
                <Type className="h-6 w-6" />
              </Button>
            )}
          </div>

          <div 
            ref={containerRef}
            className="flex-1 relative overflow-hidden"
          >
            {!capturedImage ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${facingMode === "user" ? "scale-x-[-1]" : ""}`}
                  data-testid="camera-video-feed"
                />
                {cameraError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-8">
                    <div className="text-center text-white max-w-sm">
                      <p className="text-lg mb-6">{cameraError}</p>
                      <div className="flex flex-col gap-3">
                        <Button onClick={startCamera} variant="secondary" data-testid="button-try-camera-again">
                          Try Again
                        </Button>
                        {onSwitchToUpload && (
                          <Button 
                            onClick={() => {
                              handleClose();
                              onSwitchToUpload();
                            }} 
                            variant="outline"
                            className="border-white/30 text-white hover:bg-white/20"
                            data-testid="button-switch-to-upload"
                          >
                            Upload Photo Instead
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <img
                  src={capturedImage}
                  alt="Captured"
                  className="w-full h-full object-cover"
                  data-testid="captured-image-preview"
                />
                
                {textOverlays.map(overlay => (
                  <div
                    key={overlay.id}
                    className={`absolute cursor-move select-none ${selectedTextId === overlay.id ? "ring-2 ring-white/50 rounded-lg p-2" : ""}`}
                    style={{
                      left: `${overlay.x}%`,
                      top: `${overlay.y}%`,
                      transform: "translate(-50%, -50%)",
                      fontSize: `${overlay.fontSize}px`,
                      color: overlay.color,
                      fontWeight: overlay.fontStyle === "bold" ? "bold" : "normal",
                      fontStyle: overlay.fontStyle === "italic" ? "italic" : "normal",
                      textShadow: overlay.color === "#FFFFFF" 
                        ? "2px 2px 4px rgba(0,0,0,0.8), -1px -1px 2px rgba(0,0,0,0.5)" 
                        : "2px 2px 4px rgba(255,255,255,0.5), -1px -1px 2px rgba(255,255,255,0.3)",
                      fontFamily: "'PT Sans', sans-serif",
                    }}
                    onMouseDown={(e) => handleTextDragStart(e, overlay.id)}
                    onTouchStart={(e) => handleTextDragStart(e, overlay.id)}
                    data-testid={`text-overlay-${overlay.id}`}
                  >
                    {overlay.text}
                    {selectedTextId === overlay.id && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTextOverlay(overlay.id);
                        }}
                        className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1"
                        data-testid={`button-remove-text-${overlay.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>

          {isAddingText && (
            <motion.div
              initial={{ y: 100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 100, opacity: 0 }}
              className="absolute bottom-0 left-0 right-0 bg-black/90 p-4 space-y-4 z-30"
              data-testid="text-input-panel"
            >
              <div className="flex gap-2">
                <Input
                  value={newTextValue}
                  onChange={(e) => setNewTextValue(e.target.value)}
                  placeholder="Enter text..."
                  className="flex-1 bg-white/10 border-white/20 text-white placeholder:text-white/50"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addTextOverlay();
                  }}
                  data-testid="input-text-overlay"
                />
                <Button
                  onClick={addTextOverlay}
                  className="bg-[#D0BFFF] hover:bg-[#C0AFEF] text-black"
                  disabled={!newTextValue.trim()}
                  data-testid="button-confirm-text"
                >
                  <Check className="h-5 w-5" />
                </Button>
              </div>
              
              <div className="flex items-center gap-4">
                <div className="flex gap-2">
                  {TEXT_COLORS.map(color => (
                    <button
                      key={color}
                      onClick={() => setSelectedColor(color)}
                      className={`w-8 h-8 rounded-full border-2 ${selectedColor === color ? "border-white scale-110" : "border-transparent"}`}
                      style={{ backgroundColor: color }}
                      data-testid={`color-option-${color.replace("#", "")}`}
                    />
                  ))}
                </div>
                
                <div className="flex gap-2 ml-auto">
                  {FONT_SIZES.map(size => (
                    <button
                      key={size}
                      onClick={() => setSelectedFontSize(size)}
                      className={`px-3 py-1 rounded text-white text-sm ${selectedFontSize === size ? "bg-[#D0BFFF] text-black" : "bg-white/20"}`}
                      data-testid={`font-size-${size}`}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>
              
              <Button
                variant="ghost"
                onClick={() => {
                  setIsAddingText(false);
                  setNewTextValue("");
                }}
                className="w-full text-white/70 hover:text-white"
                data-testid="button-cancel-text"
              >
                Cancel
              </Button>
            </motion.div>
          )}

          <div 
            className="absolute bottom-0 left-0 right-0 z-20 pb-8 pt-20"
            style={{ background: "linear-gradient(to top, rgba(0,0,0,0.6), transparent)" }}
          >
            {!capturedImage ? (
              <div className="flex items-center justify-center">
                <button
                  onClick={capturePhoto}
                  className="w-20 h-20 rounded-full bg-white border-4 border-[#D0BFFF] flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shadow-lg"
                  data-testid="button-capture-story"
                >
                  <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#D0BFFF] to-[#B0D0FF]" />
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-6 px-6">
                <Button
                  onClick={retakePhoto}
                  variant="outline"
                  className="flex-1 max-w-[160px] border-white/30 text-white hover:bg-white/20"
                  data-testid="button-retake-story"
                >
                  Retake
                </Button>
                <Button
                  onClick={handleConfirm}
                  className="flex-1 max-w-[160px] bg-[#D0BFFF] hover:bg-[#C0AFEF] text-black font-semibold"
                  data-testid="button-use-story-photo"
                >
                  Use Photo
                </Button>
              </div>
            )}
          </div>
          
          {capturedImage && textOverlays.length > 0 && !isAddingText && (
            <div className="absolute bottom-32 left-0 right-0 text-center">
              <p className="text-white/60 text-sm flex items-center justify-center gap-2">
                <Move className="h-4 w-4" />
                Drag text to reposition
              </p>
            </div>
          )}
        </div>
        
        <canvas ref={canvasRef} className="hidden" />
      </motion.div>
    </AnimatePresence>
  );
}
