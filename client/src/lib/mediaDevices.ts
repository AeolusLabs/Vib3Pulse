// Camera and microphone choices for going live. Pure so it can be tested; the browser calls live in the components.
export interface Dev { deviceId: string; label: string }

/**
 * Cameras and microphones only. Devices without an id are unusable; devices the browser has not named yet (it hides names
 * until permission is given) get "Camera 2" style labels, numbered by position among the usable ones.
 */
export function pickDevices(list: Array<{ kind: string; deviceId: string; label: string }>): { cameras: Dev[]; mics: Dev[] } {
  const of = (kind: string, word: string): Dev[] => {
    const all = list.filter((d) => d.kind === kind);
    const usable = all.filter((d) => d.deviceId).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${word} ${i + 1}` }));
    // Before permission is given the browser lists devices without ids: offer the default one rather than "nothing found".
    return usable.length > 0 || all.length === 0 ? usable : [{ deviceId: "", label: `Default ${word.toLowerCase()}` }];
  };
  return { cameras: of("videoinput", "Camera"), mics: of("audioinput", "Microphone") };
}

const KEY = { camera: "vp.room.camera", mic: "vp.room.mic" } as const;

/** The device this browser used last time, if it is still plugged in. Storage can be blocked or empty: then null. */
export function rememberedDevice(kind: "camera" | "mic", available: Dev[], storage?: Pick<Storage, "getItem">): string | null {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    const id = s?.getItem(KEY[kind]);
    return id && available.some((d) => d.deviceId === id) ? id : null;
  } catch {
    return null;
  }
}

export function rememberDevice(kind: "camera" | "mic", deviceId: string): void {
  try { localStorage.setItem(KEY[kind], deviceId); } catch { /* storage blocked: the choice just is not remembered */ }
}
