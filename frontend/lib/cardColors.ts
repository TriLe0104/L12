/** Hex colors for job-card header (order) and body (per part). */

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeHex(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!HEX.test(raw)) return null;
  if (raw.length === 4) {
    const [, r, g, b] = raw;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return raw.toLowerCase();
}

/** Black or white ink so header type stays readable on a custom fill. */
export function contrastInk(hex: string): string {
  const n = hex.slice(1);
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const y = (r * 299 + g * 587 + b * 114) / 1000;
  return y < 148 ? "#ffffff" : "#0d1117";
}
