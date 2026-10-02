import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";

interface AdminPaginationProps {
  offset: number;
  limit: number;
  total: number;
  onOffsetChange: (offset: number) => void;
}

// Prev/Next pager wired to the limit/offset params every admin list endpoint
// already accepts server-side.
export default function AdminPagination({ offset, limit, total, onOffsetChange }: AdminPaginationProps) {
  if (total <= limit && offset === 0) return null;

  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);

  return (
    <div className="flex items-center justify-between pt-4 text-sm text-muted-foreground">
      <span data-testid="text-pagination-range">
        Showing {start}–{end} of {total}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          data-testid="button-pagination-prev"
        >
          <ChevronLeftIcon className="w-4 h-4 mr-1" /> Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={offset + limit >= total}
          onClick={() => onOffsetChange(offset + limit)}
          data-testid="button-pagination-next"
        >
          Next <ChevronRightIcon className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
