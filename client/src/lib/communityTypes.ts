// Shared everywhere a community's type shows up as a badge/chip — the
// Communities discover modal, CommunityPage's header, and the "in
// [Community]" chip on a post shared from one (FeedPost.tsx).
export const COMMUNITY_TYPE_STYLES: Record<string, string> = {
  general: "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30",
  city: "bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/30",
  genre: "bg-purple-500/15 text-purple-600 dark:text-purple-300 border-purple-500/30",
  safety: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
  event: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30",
};

export function communityTypeStyle(type?: string | null): string {
  return COMMUNITY_TYPE_STYLES[type ?? "general"] ?? COMMUNITY_TYPE_STYLES.general;
}
