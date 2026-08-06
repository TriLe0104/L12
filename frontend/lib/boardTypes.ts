/** Board settings document — mirrors backend/app/board_defaults.py */

export type CustomFieldType = "text" | "number" | "date" | "select";

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
  tone: FieldTone | string;
}

export interface DashboardColumnConfig {
  key: string;
  label: string;
  visible: boolean;
}

export interface KanbanColumnConfig {
  key: string;
  label: string;
  tone: FieldTone | string;
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
