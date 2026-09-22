export const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  twitter: "Twitter / X",
  tiktok: "TikTok",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  threads: "Threads",
  reddit: "Reddit",
  pinterest: "Pinterest",
  bluesky: "Bluesky",
  telegram: "Telegram",
  snapchat: "Snapchat",
  whatsapp: "WhatsApp",
  discord: "Discord",
};

export const PLATFORM_COLORS: Record<string, string> = {
  instagram: "from-pink-500 to-purple-600",
  twitter:   "from-sky-400 to-sky-600",
  tiktok:    "from-black to-zinc-700",
  facebook:  "from-blue-600 to-blue-800",
  linkedin:  "from-blue-500 to-blue-700",
  youtube:   "from-red-500 to-red-700",
  threads:   "from-zinc-600 to-zinc-800",
  reddit:    "from-orange-500 to-orange-700",
  pinterest: "from-red-400 to-red-600",
  bluesky:   "from-sky-500 to-blue-600",
  telegram:  "from-sky-400 to-cyan-600",
  snapchat:  "from-yellow-400 to-yellow-500",
  whatsapp:  "from-green-500 to-green-700",
  discord:   "from-indigo-500 to-violet-600",
};

export function platformInitial(platform: string): string {
  return (PLATFORM_LABELS[platform] ?? platform).charAt(0).toUpperCase();
}
