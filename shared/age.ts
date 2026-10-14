// Age rules shared by server, WebSocket handlers and client. Pure functions only.
export const MIN_PLATFORM_AGE = 13;

export type AgeLimit = "all" | "13+" | "16+" | "18+" | "21+";
export const AGE_LIMITS: readonly AgeLimit[] = ["all", "13+", "16+", "18+", "21+"];

export type AgeBand = "teen" | "adult";

export function ageFromDob(dob: string | null | undefined, now = new Date()): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null;
  const d = new Date(dob.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export function ageBand(age: number | null): AgeBand | null {
  if (age === null || age < MIN_PLATFORM_AGE) return null;
  return age < 18 ? "teen" : "adult";
}

export function minAgeForLimit(l: AgeLimit): number {
  return l === "21+" ? 21 : l === "18+" ? 18 : l === "16+" ? 16 : MIN_PLATFORM_AGE;
}

export function meetsAgeLimit(age: number | null, l: AgeLimit): boolean {
  return age !== null && age >= minAgeForLimit(l);
}

export function sameBand(a: number | null, b: number | null): boolean {
  const x = ageBand(a), y = ageBand(b);
  return x !== null && x === y;
}
