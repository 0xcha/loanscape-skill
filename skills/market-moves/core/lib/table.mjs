// Markdown tables for chat. Numbers right-aligned, the winner on the ranked axis in bold, no rank column.
// sparkline(): eight blocks from the 30-day history plus the live reading. depthBar(): only where depth is the comparison.
const BLOCKS = "▁▂▃▄▅▆▇█";
export function sparkline(hist, live) {
  const v = [...(hist || []), ...(live == null ? [] : [live])]; if (v.length < 2) return "";
  const lo = Math.min(...v), hi = Math.max(...v); const step = Math.max(1, Math.floor(v.length / 8)); const pts = v.filter((_, i) => i % step === 0).slice(-8);
  return "`" + pts.map((x) => BLOCKS[hi === lo ? 0 : Math.min(7, Math.floor(((x - lo) / (hi - lo)) * 7.999))]).join("") + "`";
}
// Depth relative to the deepest venue (rank by depth), or the loan's share of each venue's own book (a size was given).
export function depthBar(x, max, n = 10) { if (!x || !max) return "▏"; const k = Math.round((n * x) / max); return k > 0 ? "▇".repeat(Math.min(n, k)) : "▏"; }
export function shareBar(size, liq, n = 10) { if (!liq) return ""; const s = size / liq; if (s > 1) return "▇".repeat(n) + "+"; const k = Math.round(n * s); return k > 0 ? "▇".repeat(k) : "▏"; }
// rows: array of cells; aligns: array of "l" | "r"; bold: index of the row to bold (or -1)
// bold: a row index (bolds its first two cells), or { rows: Set<number>, cols: number[] }
export function mdTable(headers, rows, aligns, bold = 0) {
  const esc = (c) => String(c ?? "").replace(/\|/g, "\\|");
  const isBold = (i, j) => typeof bold === "number" ? i === bold && j <= 1 : bold?.rows?.has(i) && bold.cols.includes(j);
  const head = "| " + headers.map(esc).join(" | ") + " |";
  const sep = "|" + headers.map((_, i) => (aligns[i] === "r" ? "--:" : ":--")).join("|") + "|";
  const body = rows.map((r, i) => "| " + r.map((c, j) => (isBold(i, j) && c !== "" ? `**${esc(c)}**` : esc(c))).join(" | ") + " |");
  return [head, sep, ...body].join("\n");
}
