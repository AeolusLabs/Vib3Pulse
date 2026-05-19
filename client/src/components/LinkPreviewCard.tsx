import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "@/components/ui/icons";

interface LinkPreviewMetadata {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  domain: string;
  favicon: string | null;
}

interface LinkPreviewCardProps {
  url: string;
}

export default function LinkPreviewCard({ url }: LinkPreviewCardProps) {
  const { data: preview, isLoading, error } = useQuery<LinkPreviewMetadata>({
    queryKey: ['/api/link-preview', url],
    queryFn: async () => {
      const response = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Failed to fetch preview');
      }
      return response.json();
    },
    staleTime: 1000 * 60 * 60,
    retry: 1,
    enabled: !!url,
  });

  if (isLoading) {
    return (
      <div className="mt-2 rounded-xl border border-white/10 bg-white/5 overflow-hidden animate-pulse">
        <div className="flex">
          <div className="w-24 h-24 bg-white/10 shrink-0" />
          <div className="p-3 flex-1 min-w-0 space-y-2">
            <div className="h-3 bg-white/10 rounded w-3/4" />
            <div className="h-3 bg-white/10 rounded w-1/2" />
            <div className="h-2 bg-white/10 rounded w-1/3" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !preview || (!preview.title && !preview.description && !preview.image)) {
    return null;
  }

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="block mt-2 rounded-xl border border-white/10 bg-white/5 overflow-hidden hover:bg-white/10 transition-colors group"
      data-testid="link-preview-card"
    >
      <div className="flex">
        {preview.image && (
          <div className="w-24 h-24 shrink-0 bg-black/20 overflow-hidden">
            <img
              src={preview.image}
              alt={preview.title || 'Link preview'}
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          </div>
        )}
        <div className="p-3 flex-1 min-w-0 flex flex-col justify-center">
          {preview.title && (
            <h4 className="font-medium text-sm text-foreground line-clamp-1 group-hover:text-primary transition-colors">
              {preview.title}
            </h4>
          )}
          {preview.description && (
            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
              {preview.description}
            </p>
          )}
          <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground">
            {preview.favicon && (
              <img
                src={preview.favicon}
                alt=""
                className="w-3 h-3 rounded-sm"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
            <span className="truncate">{preview.domain}</span>
            <ExternalLinkIcon className="w-3 h-3 shrink-0 opacity-50" />
          </div>
        </div>
      </div>
    </a>
  );
}

export function extractFirstUrl(text: string): string | null {
  const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,;:'")\]])/gi;
  const matches = text.match(urlRegex);
  return matches ? matches[0] : null;
}
