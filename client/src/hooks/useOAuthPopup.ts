import { useEffect, useRef } from "react";

// Opens a popup to the Zernio OAuth connect flow and listens for the
// same-origin postMessage the callback route sends on completion
// (server/socialRoutes.ts's /api/auth/social/callback).
export function useOAuthPopup(onSuccess: () => void) {
  const popupRef = useRef<Window | null>(null);

  const open = (platform: string) => {
    const url = `/api/auth/social/connect?platform=${encodeURIComponent(platform)}`;
    const popup = window.open(url, `connect_${platform}`, "width=600,height=700,popup=1");
    popupRef.current = popup;
  };

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data && typeof e.data === "object" && "success" in e.data) {
        if (e.data.success) {
          onSuccess();
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onSuccess]);

  return open;
}
