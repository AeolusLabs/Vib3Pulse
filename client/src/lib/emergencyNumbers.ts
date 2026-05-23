export const EMERGENCY_NUMBERS: Record<string, string> = {
  GB: "999", NG: "112", US: "911",
};

export const EMERGENCY_FALLBACK = "999 (UK) · 112 (Nigeria/EU) · 911 (US)";

export function getEmergencyNumber(cc?: string | null): string {
  return cc ? (EMERGENCY_NUMBERS[cc] ?? EMERGENCY_FALLBACK) : EMERGENCY_FALLBACK;
}