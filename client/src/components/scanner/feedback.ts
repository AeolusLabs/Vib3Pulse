// Sound and vibration for scan results, so door staff can look at the crowd instead of the screen.

const MUTE_KEY = "vp_scanner_muted";

export const isMuted = (): boolean => {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
};
export const setMuted = (muted: boolean): void => {
  try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* storage blocked: mute lasts this session only */ }
};

let ctx: AudioContext | null = null;

function tone(freq: number, start: number, duration: number, gain = 0.2) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, ctx.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + duration + 0.02);
}

/** Must first run from a tap (browsers block audio until then); the Start button does that. */
export function primeAudio(): void {
  try {
    ctx = ctx ?? new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === "suspended") void ctx.resume();
  } catch { /* no audio available */ }
}

export type FeedbackKind = "ok" | "reject" | "warn";

export function signal(kind: FeedbackKind): void {
  try {
    if (!isMuted()) {
      if (kind === "ok") { tone(880, 0, 0.12); tone(1320, 0.1, 0.16); }
      else if (kind === "reject") { tone(220, 0, 0.18, 0.28); tone(180, 0.22, 0.28, 0.28); }
      else tone(520, 0, 0.25);
    }
    // Vibration is not covered by mute: it is the silent signal.
    if ("vibrate" in navigator) navigator.vibrate(kind === "ok" ? 60 : kind === "reject" ? [120, 60, 120] : 90);
  } catch { /* feedback is a nicety, never block a scan on it */ }
}
