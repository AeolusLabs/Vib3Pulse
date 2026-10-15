import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "@/components/ui/icons";

/** Shown to both people in a direct chat when one is an adult and the other is under 18. Nothing for any other chat. */
export default function AgeGapNotice({ conversationId }: { conversationId: string }) {
  const { data } = useQuery<{ notice: { otherIs: "minor" | "adult"; message: string } | null }>({
    queryKey: ["/api/conversations", conversationId, "age-notice"],
    queryFn: async () => {
      const r = await fetch(`/api/conversations/${conversationId}/age-notice`, { credentials: "include" });
      return r.ok ? r.json() : { notice: null };
    },
    staleTime: 5 * 60_000,
  });
  if (!data?.notice) return null;
  return (
    <div role="note" className="flex flex-none items-start gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs" data-testid="age-gap-notice">
      <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 flex-none text-amber-600" aria-hidden />
      <span>{data.notice.message}</span>
    </div>
  );
}
