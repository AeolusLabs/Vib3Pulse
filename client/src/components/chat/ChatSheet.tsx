import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

// Shared shell for the messaging sheets: bottom sheet on phones, right-hand panel on md+.
export default function ChatSheet({
  open,
  onOpenChange,
  title,
  description,
  hideHeader,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  hideHeader?: boolean;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "flex flex-col gap-0 p-0",
          isMobile ? "h-[92vh] max-h-[92vh] rounded-t-2xl" : "w-full sm:max-w-md"
        )}
      >
        <SheetHeader className={cn("px-4 pb-3 pt-5 text-left", hideHeader && "sr-only")}>
          <SheetTitle className="font-serif text-2xl font-semibold tracking-tight">{title}</SheetTitle>
          <SheetDescription className={description ? "text-sm" : "sr-only"}>{description || title}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

export const SectionTitle = ({ children }: { children: ReactNode }) => (
  <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{children}</h3>
);

// Two-option segmented control (aria-pressed buttons, 44px tall).
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="flex h-11 w-full rounded-lg bg-muted p-1" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded-md text-sm font-medium transition-[background-color,color,transform] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === o.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
