import { useLayoutEffect, useRef, useState } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export interface UnderlineTab {
  value: string;
  label: string;
  count?: number;
  icon?: React.ReactNode;
  testId?: string;
}

interface Props {
  value: string; // controlled: the parent's <Tabs value> — the indicator follows it
  items: UnderlineTab[];
  className?: string;
}

// Tab bar for use inside <Tabs value onValueChange>. The 2px indicator slides between tabs
// using transform only (translateX + scaleX of a 1px base) so it never triggers layout.
export function UnderlineTabs({ value, items, className }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; w: number } | null>(null);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-tab="${value}"]`);
      if (el) setPos({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (listRef.current) ro.observe(listRef.current);
    // No slide on first paint, only on user-driven changes.
    const t = requestAnimationFrame(() => setAnimate(true));
    return () => { ro.disconnect(); cancelAnimationFrame(t); };
  }, [value, items.length]);

  return (
    <TabsList
      ref={listRef}
      className={cn(
        "relative h-auto w-full justify-start gap-1 rounded-none border-b bg-transparent p-0 overflow-x-auto",
        className,
      )}
    >
      {items.map((t) => (
        <TabsTrigger
          key={t.value}
          value={t.value}
          data-tab={t.value}
          data-testid={t.testId}
          className={cn(
            "relative min-h-[44px] gap-2 rounded-none bg-transparent px-3.5 py-3 text-sm font-medium text-muted-foreground shadow-none",
            "transition-colors duration-150 ease-out hover:text-foreground",
            "data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none",
          )}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] leading-none tabular-nums text-muted-foreground">
              {t.count}
            </span>
          )}
        </TabsTrigger>
      ))}
      {pos && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute bottom-0 left-0 h-0.5 w-px origin-left bg-primary",
            animate && "transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
          )}
          style={{ transform: `translateX(${pos.x}px) scaleX(${pos.w})` }}
        />
      )}
    </TabsList>
  );
}
