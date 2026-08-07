/** Board settings document — mirrors backend/app/board_defaults.py */

export type CustomFieldType = "text" | "number" | "date" | "select";

/** Legacy named tones (still accepted from older documents). */
export type FieldTone =
  | "slate"
  | "cyan"
  | "blue"
  | "teal"
  | "amber"
  | "red"
  | "green"
  | "graphite"
  | "orange";

/** Hex values matching frontend/app/globals.css --tone-* tokens. */
export const TONE_HEX: Record<FieldTone, string> = {
  slate: "#64748b",
  cyan: "#0e7490",
  blue: "#1d4ed8",
  teal: "#0f766e",
  amber: "#b45309",
  red: "#c81e2b",
  green: "#0b8457",
  graphite: "#3f4b57",
  orange: "#c2410c",
};

export const DEFAULT_TONE_HEX = TONE_HEX.slate;

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Resolve a stored tone (hex or legacy name) to a CSS color string. */
export function resolveToneColor(tone?: string | null): string {
  if (!tone) return DEFAULT_TONE_HEX;
  const trimmed = tone.trim();
  const named = TONE_HEX[trimmed.toLowerCase() as FieldTone];
  if (named) return named;
  if (HEX_RE.test(trimmed)) {
    const body = trimmed.slice(1);
    if (body.length === 3) {
      return `#${body
        .split("")
        .map((c) => c + c)
        .join("")
        .toLowerCase()}`;
    }
    return `#${body.toLowerCase()}`;
  }
  return DEFAULT_TONE_HEX;
}

/** `#rrggbb` for `<input type="color">` (browsers reject alpha / short forms). */
export function toColorInputValue(tone?: string | null): string {
  const resolved = resolveToneColor(tone);
  if (resolved.length === 9) return resolved.slice(0, 7);
  return resolved.length === 7 ? resolved : DEFAULT_TONE_HEX;
}

/** Return a normalised hex if `raw` is valid; otherwise null (for live hex typing). */
export function tryParseToneHex(raw: string): string | null {
  const trimmed = raw.trim();
  const named = TONE_HEX[trimmed.toLowerCase() as FieldTone];
  if (named) return named;
  if (!HEX_RE.test(trimmed)) return null;
  return resolveToneColor(trimmed);
}

export interface CardFieldConfig {
  key: string;
  kind: "builtin" | "custom";
  label: string;
  visible: boolean;
}

export interface CustomFieldConfig {
  key: string;
  label: string;
  type: CustomFieldType;
  options?: string[];
}

export interface StatusConfig {
  key: string;
  label: string;
  /** CSS hex (`#rrggbb`) or legacy named tone. */
  tone: string;
}

export interface DashboardColumnConfig {
  key: string;
  label: string;
  visible: boolean;
}

export interface KanbanColumnConfig {
  key: string;
  label: string;
  /** CSS hex (`#rrggbb`) or legacy named tone. */
  tone: string;
  statusKeys: string[];
  isCompleted: boolean;
}

export interface BoardDocument {
  version: number;
  cardFields: CardFieldConfig[];
  customFields: CustomFieldConfig[];
  statuses: StatusConfig[];
  dashboardColumns: DashboardColumnConfig[];
  kanbanColumns: KanbanColumnConfig[];
}

export interface BoardSettings {
  version: number;
  updated_at: string | null;
  updated_by_id: string | null;
  document: BoardDocument;
}

export const BOARD_TONES: FieldTone[] = [
  "slate",
  "cyan",
  "blue",
  "teal",
  "amber",
  "red",
  "green",
  "graphite",
  "orange",
];

/** Fixed sample PO for the settings live preview — never mutates production rows. */
export const PREVIEW_SAMPLE = {
  job_no: "J-42",
  po_number: "J03CE6AA",
  part_number: "0A44DD1",
  qty: 4,
  due_date: "2026-08-20",
  dims: "0.905 x 0.870 x 0.345in",
  mat_dim: "1.25 x 1.7 x .500",
  material: "AL 6061-T651, Plate",
  finish: "CLEAR ANODIZE",
  inspection: "standard",
  hardware: false,
  status: "in_machining",
  status_label: "IN MACHINING",
  stage: "in_progress",
  priority: "high",
  priority_label: "HIGH",
  locked: false,
  customer: "Acme Robotics",
  note: "Sample card for settings preview",
  thumbnail_url: null,
  model_url: null,
  model_filename: null,
  model_size: null,
  owner: { id: "preview", name: "Alex Chen", initials: "AC", avatar_url: null },
  custom_fields: {} as Record<string, string | number | null>,
};
