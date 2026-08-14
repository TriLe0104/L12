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
  | "orange"
  | "purple";

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
  purple: "#6d28d9",
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
  /** Builtin wire type (customs use customFields[].type). */
  type?: CustomFieldType;
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
  /** Column width in rem; `null` = auto / flex share. */
  widthRem?: number | null;
  /**
   * When true, this column appears as a filter control on the dashboard
   * (stage pills, or a status/priority/customer select). Only meaningful for
   * keys in `DASHBOARD_FILTER_KEYS`.
   */
  filterable?: boolean;
}

/** Columns that can drive dashboard filter controls. */
export const DASHBOARD_FILTER_KEYS = ["stage", "status", "priority", "customer"] as const;

export type DashboardFilterKey = (typeof DASHBOARD_FILTER_KEYS)[number];

/** Day-one defaults: stage / status / priority filters on; customer off. */
export const DEFAULT_FILTERABLE_KEYS: ReadonlySet<string> = new Set([
  "stage",
  "status",
  "priority",
]);

export function canFilterDashboardColumn(key: string): boolean {
  return (DASHBOARD_FILTER_KEYS as readonly string[]).includes(key);
}

export function defaultDashboardFilterable(key: string): boolean {
  return DEFAULT_FILTERABLE_KEYS.has(key);
}

/** Rem widths matching dashboard.css day-one tracks; null = auto absorber. */
export const DEFAULT_DASHBOARD_WIDTH_REM: Record<string, number | null> = {
  job: 4.3,
  po_number: 4.8,
  customer: 5.7,
  priority: 5.4,
  stage: 6.7,
  status: 8.75,
  owner: 5.0,
  material: null,
  finish: null,
  due: 4.3,
  modified: 5.4,
  comments: 2.35,
  qty: 3.75,
  part_number: 4.8,
  dims: 6.0,
  mat_dim: 6.0,
  inspection: 5.5,
  hardware: 4.5,
  certificates: 6.5,
};

/** Builtin dashboard column catalog (order + default visibility / filterable). */
export const BUILTIN_DASHBOARD_COLUMNS: DashboardColumnConfig[] = [
  { key: "job", label: "Job", visible: true, widthRem: 4.3, filterable: false },
  { key: "po_number", label: "PO #", visible: true, widthRem: 4.8, filterable: false },
  { key: "customer", label: "Customer", visible: true, widthRem: 5.7, filterable: false },
  { key: "priority", label: "Priority", visible: true, widthRem: 5.4, filterable: true },
  { key: "stage", label: "Stage", visible: true, widthRem: 6.7, filterable: true },
  { key: "status", label: "Status", visible: true, widthRem: 8.75, filterable: true },
  { key: "owner", label: "Owner", visible: true, widthRem: 5.0, filterable: false },
  { key: "material", label: "Material", visible: true, widthRem: null, filterable: false },
  { key: "finish", label: "Finish", visible: true, widthRem: null, filterable: false },
  { key: "certificates", label: "Certificates", visible: false, widthRem: 6.5, filterable: false },
  { key: "due", label: "Due", visible: true, widthRem: 4.3, filterable: false },
  { key: "modified", label: "Modified", visible: true, widthRem: 5.4, filterable: false },
  { key: "comments", label: "Comments", visible: true, widthRem: 2.35, filterable: false },
  { key: "qty", label: "Qty", visible: true, widthRem: 3.75, filterable: false },
  { key: "part_number", label: "Part #", visible: false, widthRem: 4.8, filterable: false },
  { key: "dims", label: "Dims", visible: false, widthRem: 6.0, filterable: false },
  { key: "mat_dim", label: "Mat Dim", visible: false, widthRem: 6.0, filterable: false },
  { key: "inspection", label: "Inspection", visible: false, widthRem: 5.5, filterable: false },
  { key: "hardware", label: "Hardware", visible: false, widthRem: 4.5, filterable: false },
];

const BUILTIN_DASHBOARD_BY_KEY = Object.fromEntries(
  BUILTIN_DASHBOARD_COLUMNS.map((c) => [c.key, c]),
);

function parseWidthRem(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/** Merge dashboard columns with builtins + custom fields (new keys hidden). */
export function syncDashboardColumns(doc: BoardDocument): DashboardColumnConfig[] {
  const customByKey = new Map(doc.customFields.map((f) => [f.key, f]));
  const cardLabelByKey = new Map(
    doc.cardFields.map((f) => [f.key, f.label] as const).filter(([, l]) => !!l?.trim()),
  );
  const allowed = new Set([
    ...BUILTIN_DASHBOARD_COLUMNS.map((c) => c.key),
    ...customByKey.keys(),
  ]);
  const out: DashboardColumnConfig[] = [];
  const seen = new Set<string>();

  for (const item of doc.dashboardColumns ?? []) {
    if (!item?.key || !allowed.has(item.key) || seen.has(item.key)) continue;
    const builtin = BUILTIN_DASHBOARD_BY_KEY[item.key];
    const stored = item.label?.trim();
    const label =
      stored ||
      cardLabelByKey.get(item.key) ||
      builtin?.label ||
      customByKey.get(item.key)?.label ||
      item.key;
    const widthRem =
      "widthRem" in item
        ? parseWidthRem(item.widthRem)
        : (DEFAULT_DASHBOARD_WIDTH_REM[item.key] ?? null);
    const filterable = canFilterDashboardColumn(item.key)
      ? "filterable" in item
        ? Boolean(item.filterable)
        : defaultDashboardFilterable(item.key)
      : false;
    out.push({
      key: item.key,
      label,
      visible: item.key === "job" ? true : Boolean(item.visible),
      widthRem,
      filterable,
    });
    seen.add(item.key);
  }

  for (const entry of BUILTIN_DASHBOARD_COLUMNS) {
    if (seen.has(entry.key)) continue;
    out.push({
      key: entry.key,
      label: cardLabelByKey.get(entry.key) || entry.label,
      visible: entry.key === "job" ? true : false,
      widthRem: entry.widthRem ?? null,
      filterable: entry.filterable ?? defaultDashboardFilterable(entry.key),
    });
    seen.add(entry.key);
  }

  for (const cf of doc.customFields) {
    if (seen.has(cf.key)) continue;
    out.push({
      key: cf.key,
      label: cf.label,
      visible: false,
      widthRem: null,
      filterable: false,
    });
    seen.add(cf.key);
  }

  return out;
}

/** CSS width for a column config; undefined leaves layout to CSS auto tracks. */
export function dashboardColumnWidthStyle(
  widthRem: number | null | undefined,
): { width: string; minWidth: string } | undefined {
  if (widthRem == null || !(widthRem > 0)) return undefined;
  const w = `${widthRem}rem`;
  return { width: w, minWidth: w };
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
  /**
   * Select-field options keyed by field key (`material`, custom select keys).
   * Preferred over legacy `materialTypes`.
   */
  selectionLists?: Record<string, string[]>;
  /** @deprecated Migrated into selectionLists.material */
  materialTypes?: string[];
}

/** Builtin select field keys (options live in selectionLists). */
export const MATERIAL_FIELD_KEY = "material";
export const INSPECTION_FIELD_KEY = "inspection";
export const HARDWARE_FIELD_KEY = "hardware";
export const PRIORITY_FIELD_KEY = "priority";

export const BUILTIN_SELECT_FIELD_KEYS = [
  MATERIAL_FIELD_KEY,
  INSPECTION_FIELD_KEY,
  HARDWARE_FIELD_KEY,
  PRIORITY_FIELD_KEY,
] as const;

/** Day-one wire type per builtin card field. */
export const BUILTIN_DEFAULT_TYPES: Record<string, CustomFieldType> = {
  po_number: "text",
  part_number: "text",
  qty: "number",
  dims: "text",
  mat_dim: "text",
  material: "select",
  finish: "text",
  inspection: "select",
  hardware: "select",
  priority: "select",
  customer: "text",
  owner: "text",
  certificates: "text",
};

/**
 * Allowed type transitions. Keys stay bound to the same PO columns;
 * unsafe changes (PO#/Part# away from text, owner away from assignee, hardware
 * away from select) are refused.
 */
export const BUILTIN_ALLOWED_TYPES: Record<string, readonly CustomFieldType[]> = {
  po_number: ["text"],
  part_number: ["text"],
  qty: ["number", "text", "select"],
  dims: ["text", "number", "select", "date"],
  mat_dim: ["text", "number", "select", "date"],
  material: ["select", "text"],
  finish: ["text", "select", "number", "date"],
  inspection: ["select", "text"],
  hardware: ["select"],
  priority: ["select", "text"],
  customer: ["text", "select", "number", "date"],
  owner: ["text"],
  certificates: ["text", "select", "number", "date"],
};

export const CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = [
  "text",
  "number",
  "date",
  "select",
];

/** Resolve the effective type for a card field row. */
export function resolveCardFieldType(
  doc: BoardDocument | null | undefined,
  field: CardFieldConfig,
): CustomFieldType {
  if (field.kind === "custom") {
    const custom = doc?.customFields?.find((f) => f.key === field.key);
    return custom?.type ?? "text";
  }
  if (field.type && CUSTOM_FIELD_TYPES.includes(field.type)) {
    const allowed = BUILTIN_ALLOWED_TYPES[field.key];
    if (!allowed || allowed.includes(field.type)) return field.type;
  }
  return BUILTIN_DEFAULT_TYPES[field.key] ?? "text";
}

/** Types the settings type picker may offer for this field. */
export function allowedCardFieldTypes(
  doc: BoardDocument | null | undefined,
  field: CardFieldConfig,
): readonly CustomFieldType[] {
  if (field.kind === "custom") return CUSTOM_FIELD_TYPES;
  return BUILTIN_ALLOWED_TYPES[field.key] ?? ["text"];
}

export const DEFAULT_SELECTION_LISTS: Record<string, string[]> = {
  material: [], // seeded from API; material catalog is large
  inspection: ["formal", "standard", "source", "none"],
  hardware: ["no", "yes"],
  priority: ["hot", "high", "normal", "low"],
};

/** Resolve options for a select field from the published/draft document. */
export function selectionOptions(
  doc: BoardDocument | null | undefined,
  fieldKey: string,
): string[] {
  if (!doc) {
    return DEFAULT_SELECTION_LISTS[fieldKey] ?? [];
  }
  const fromLists = doc.selectionLists?.[fieldKey];
  if (Array.isArray(fromLists) && fromLists.length) return fromLists;
  if (Array.isArray(fromLists)) {
    // Explicit empty list (e.g. new custom select) — don't fall through to defaults
    // for custom keys; builtins still fall back to day-one seeds.
    if (!(BUILTIN_SELECT_FIELD_KEYS as readonly string[]).includes(fieldKey)) {
      return fromLists;
    }
  }
  if (fieldKey === MATERIAL_FIELD_KEY && Array.isArray(doc.materialTypes) && doc.materialTypes.length) {
    return doc.materialTypes;
  }
  const custom = doc.customFields?.find((f) => f.key === fieldKey);
  if (custom?.type === "select" && Array.isArray(custom.options)) {
    return custom.options;
  }
  return DEFAULT_SELECTION_LISTS[fieldKey] ?? [];
}

/** True when the card-field row should expose a collapsible options editor. */
export function isSelectCardField(
  doc: BoardDocument,
  field: CardFieldConfig,
): boolean {
  return resolveCardFieldType(doc, field) === "select";
}

/** Display label for a select option (priority/inspection traditionally uppercased). */
export function optionDisplayLabel(fieldKey: string, option: string): string {
  if (
    fieldKey === PRIORITY_FIELD_KEY ||
    fieldKey === INSPECTION_FIELD_KEY ||
    fieldKey === HARDWARE_FIELD_KEY
  ) {
    return option === option.toLowerCase() ? option.toUpperCase() : option;
  }
  return option;
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
  "purple",
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
  status: "running",
  status_label: "Running",
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
