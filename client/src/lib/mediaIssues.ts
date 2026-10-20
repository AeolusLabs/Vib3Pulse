// Mic and camera trouble in a room (flows board 11, "Mic blocked"): why it failed, the one line shown inline, and the sheet's words.
// Pure: no browser calls. The room voice hook turns a thrown error into a reason here; the shell turns the hook's line back into
// an issue, so the sheet and the inline line can never disagree. Plain words, no blame, always what to do next.

export type MediaDevice = "mic" | "camera";
/** denied: the browser or the person said no. busy: another app has it, or it would not start. missing: no such device. */
export type MediaReason = "denied" | "busy" | "missing";
export interface MediaIssue { device: MediaDevice; reason: MediaReason }

/** Reads a thrown error by its DOM name first, then its words. Anything unrecognised counts as "busy" (it would not start). */
export function classifyMediaFailure(e: unknown): MediaReason {
  const err = (typeof e === "object" && e !== null ? e : {}) as { name?: unknown; message?: unknown };
  const text = `${String(err.name ?? "")} ${String(err.message ?? "")}`;
  if (/NotAllowed|PermissionDenied|SecurityError|denied|permission/i.test(text)) return "denied";
  if (/NotFound|DevicesNotFound|Overconstrained|requested device not found|no (camera|microphone|device)/i.test(text)) return "missing";
  return "busy";
}

interface Copy {
  /** The short line shown where the control is (kept by the hooks as micError / cameraError). */
  line: string;
  title: string;
  body: string;
  /** Primary button; the secondary is always "Keep listening" (mic) or "Not now" (camera). */
  primary: string;
}

export const MEDIA_ISSUE_COPY: Record<MediaDevice, Record<MediaReason, Copy>> = {
  mic: {
    denied: {
      line: "Your browser blocked the microphone. Allow it in the address bar and try again.",
      title: "Microphone is blocked",
      body: "Turn it on in your browser settings, then tap Try again. You can still listen and chat.",
      primary: "Try again",
    },
    busy: {
      line: "Couldn't start the microphone. Another app may be using it.",
      title: "Microphone is in use",
      body: "Close any other app or tab that is using it, then tap Try again. You can still listen and chat.",
      primary: "Try again",
    },
    missing: {
      line: "No microphone found. Plug one in and try again.",
      title: "No microphone found",
      body: "Plug one in or switch it on, then tap Try again. You can still listen and chat.",
      primary: "Try again",
    },
  },
  camera: {
    denied: {
      line: "Your browser blocked the camera or microphone. Allow it in the address bar and try again.",
      title: "Camera is blocked",
      body: "Turn it on in your browser settings, then tap Try again. The room carries on without you.",
      primary: "Try again",
    },
    busy: {
      line: "Couldn't start your camera. Another app may be using it.",
      title: "Camera is in use",
      body: "Close any other app or tab that is using it, then tap Try again. The room carries on without you.",
      primary: "Try again",
    },
    missing: {
      line: "No camera found. Plug one in and try again.",
      title: "No camera found",
      body: "Plug one in or switch it on, then tap Try again. The room carries on without you.",
      primary: "Try again",
    },
  },
};

/** The inline line for a failure. */
export function mediaIssueLine(device: MediaDevice, e: unknown): string {
  return MEDIA_ISSUE_COPY[device][classifyMediaFailure(e)].line;
}

/** The inline line for a reason already known (the camera start path has classified it). */
export function mediaLineFor(device: MediaDevice, reason: MediaReason): string {
  return MEDIA_ISSUE_COPY[device][reason].line;
}

/** Turns a line the hooks kept back into the issue it came from. Anything else (a drop, a connection line) is not a media issue. */
export function mediaIssueFromLine(micError: string | null | undefined, cameraError: string | null | undefined): MediaIssue | null {
  const find = (device: MediaDevice, line: string | null | undefined): MediaIssue | null => {
    if (!line) return null;
    for (const reason of ["denied", "busy", "missing"] as const) if (MEDIA_ISSUE_COPY[device][reason].line === line) return { device, reason };
    return null;
  };
  return find("camera", cameraError) ?? find("mic", micError);
}
