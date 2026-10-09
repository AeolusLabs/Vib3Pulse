// Pure text scanner for PUBLIC social events. No DB, no I/O, so it is trivially testable.
//
//   external_link       URLs, bare domains, link shorteners ("wa.me/…", "bit.ly/…")
//   contact_pattern     "contact me on WhatsApp/Telegram", phone numbers, e-mail addresses
//   free_entry_payment  "free entry" copy that also asks for money (classic bait-and-switch)
//
// New accounts get external_link / contact_pattern BLOCKED; free_entry_payment is flagged
// into the moderation queue for everyone. The admin-editable blocked-pattern list
// (moderation_config.blocked_patterns) extends the built-in floor below.

export type ContentFlag = "external_link" | "contact_pattern" | "free_entry_payment";

const TLDS = "com|net|org|io|co|uk|ng|me|ly|link|xyz|info|biz|app|gg|tv|ru|top|site|online|live|club|shop|store|page|ws|cc|to|sh|so|us|ca|de|fr|in|za|gh|ke";

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/;
const DOMAIN_RE = new RegExp(`\\b[a-z0-9][a-z0-9-]*\\.(?:${TLDS})\\b`);
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/;
const PHONE_RE = /(?:\+|\b00)?\d(?:[\s().-]?\d){8,}/; // 9+ digits, allowing separators
const BUILTIN_CONTACT = ["whatsapp", "telegram", "wechat", "snapchat"];

const FREE_RE = /\bfree\s*(?:entry|entrance|admission|access|ticket|tickets|to\s+(?:enter|attend|join)|event)\b|\bno\s+cover\b/;
const PAYMENT_RE = /\b(?:pay|paying|payment|deposit|transfer|bank|account\s*(?:no|number)|paypal|venmo|cash\s?app|cashapp|crypto|bitcoin|usdt|western\s+union|gift\s*cards?|(?:booking|registration|processing|reservation|entry|admin)\s+fee|send\s+(?:money|cash|funds))\b|[£$€₦]\s?\d/;

// Defeat the cheap evasions: full-width/compat characters, zero-width joiners, "dot" spelled out.
export function normalizeForScan(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[​-‏⁠﻿­]/g, "")
    .toLowerCase()
    .replace(/\s*[\[(]\s*dot\s*[\])]\s*|\s+dot\s+/g, ".")
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/g, "@");
}

const compact = (s: string) => s.replace(/[^a-z0-9]/g, "");

function isLinkPattern(p: string): boolean {
  return /[/.]/.test(p) || p.startsWith("http") || p.startsWith("www");
}

export function scanContent(texts: Array<string | null | undefined>, blockedPatterns: string[] = []): ContentFlag[] {
  const text = normalizeForScan(texts.filter((t): t is string => !!t).join("\n"));
  if (!text.trim()) return [];
  const squashed = compact(text);
  const flags = new Set<ContentFlag>();

  if (URL_RE.test(text) || DOMAIN_RE.test(text)) flags.add("external_link");
  // Dates ("2027-03-20 19:00", "20/03/2027") have 8-10 digits and must not read as phone numbers.
  const withoutDates = text.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ").replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, " ");
  if (EMAIL_RE.test(text) || PHONE_RE.test(withoutDates)) flags.add("contact_pattern");

  const patterns = [...BUILTIN_CONTACT, ...blockedPatterns].map(normalizeForScan).filter(Boolean);
  for (const p of patterns) {
    const hit = text.includes(p) || (/^[a-z]{6,}$/.test(p) && squashed.includes(p)); // "w h a t s a p p"
    if (hit) flags.add(isLinkPattern(p) ? "external_link" : "contact_pattern");
  }

  if (FREE_RE.test(text) && PAYMENT_RE.test(text)) flags.add("free_entry_payment");
  return Array.from(flags);
}

export const BLOCKING_FLAGS: ContentFlag[] = ["external_link", "contact_pattern"];
export const hasBlockingFlag = (flags: ContentFlag[]) => flags.some((f) => BLOCKING_FLAGS.includes(f));
