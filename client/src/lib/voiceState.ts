// Pure helpers for the room's voice UI.
export type VoiceStatus = "off" | "needs-tap" | "connecting" | "listening" | "speaking" | "error";

export function voiceStatus(i: { voiceEnabled: boolean; unlocked: boolean; connected: boolean; failed: boolean; canPublish: boolean; micOn: boolean }): VoiceStatus {
  if (!i.voiceEnabled) return "off";
  if (!i.unlocked) return "needs-tap";
  if (i.failed) return "error";
  if (!i.connected) return "connecting";
  return i.canPublish && i.micOn ? "speaking" : "listening";
}

/** Who gets a speaking ring: only people on the stage (host, co-hosts, stage guests), lit while they are the active speaker. */
export function speakingRings(speakers: string[], active: string[]): Record<string, boolean> {
  return Object.fromEntries(speakers.map((id) => [id, active.includes(id)]));
}

/** Host and co-hosts are always speakers; guests only while on the stage. Only people present are listed, once each. */
export function speakerIds(members: Array<{ userId: string; role: "host" | "cohost" | "guest" }>, stage: string[]): string[] {
  const onStage = new Set(stage);
  return members.filter((m) => m.role !== "guest" || onStage.has(m.userId)).map((m) => m.userId);
}
