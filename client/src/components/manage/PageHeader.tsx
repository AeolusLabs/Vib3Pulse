interface Props {
  eyebrow: string;
  title: string;
  summary?: React.ReactNode; // one plain-language line, e.g. "3 live · 2 drafts"
  actions?: React.ReactNode;
  titleTestId?: string;
}

export function PageHeader({ eyebrow, title, summary, actions, titleTestId }: Props) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{eyebrow}</p>
        <h1 className="mt-1 font-serif text-3xl font-bold leading-[1.05] tracking-tight sm:text-4xl" data-testid={titleTestId}>
          {title}
        </h1>
        {summary && <p className="mt-2 text-sm text-muted-foreground">{summary}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
