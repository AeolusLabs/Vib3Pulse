// Client-side CSV export from already-fetched rows (current page/dataset) —
// no backend streaming endpoint needed for admin-panel scale.
export function exportToCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;

  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const str = typeof value === "object" ? JSON.stringify(value) : String(value);
    return `"${str.replace(/"/g, '""')}"`;
  };

  const lines = [
    headers.map(escape).join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(",")),
  ];

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
