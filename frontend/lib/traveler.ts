import type { PODraft } from "./types";

export type TravelerFieldMap = Record<string, string | number | null>;

/** Follow the job card unless the user detaches the field on the traveler. */
export const CARD_LINKED_TRAVELER_KEYS = [
  "work_order",
  "due_date",
  "mat_dim",
  "po_number",
  "part_name",
  "part_number",
  "qty",
  "finish",
  "inserts",
  "material",
  "inspection",
  "certificates",
  "notes",
  "dims",
  "customer",
  "part_of",
] as const;

export const TRAVELER_ONLY_KEYS = [
  "sign",
  "material_spec",
  "part_marking",
  "programmer",
  "program_date",
] as const;

const LINKED = new Set<string>(CARD_LINKED_TRAVELER_KEYS);

export function isCardLinkedTravelerKey(key: string): boolean {
  return LINKED.has(key);
}

export function inspectionTravelerLabel(value: string | null | undefined): string {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .split(".")
    .pop();
  return (
    {
      formal: "Formal Inspection with / Dimensional Report",
      standard: "Standard Inspection",
      source: "Source Inspection",
      none: "None",
    }[raw ?? ""] ?? (value?.trim() || "Standard Inspection")
  );
}

/** Live card → traveler values for linked fields. */
export function cardToTravelerSource(
  draft: PODraft,
  partIndex: number | null,
  partCount: number,
): TravelerFieldMap {
  const total = partCount > 0 ? partCount : 1;
  const partNo = partIndex != null ? partIndex + 1 : 1;
  const partName = (draft as { part_name?: string }).part_name;
  return {
    work_order: draft.job_no ?? "",
    due_date: draft.due_date ?? "",
    mat_dim: draft.mat_dim ?? "",
    po_number: draft.po_number ?? "",
    part_name: partName || draft.part_number || "",
    part_number: draft.part_number ?? "",
    qty: draft.qty ?? "",
    finish: draft.finish ?? "",
    inserts: draft.hardware ? "Yes" : "No",
    material: draft.material ?? "",
    inspection: inspectionTravelerLabel(draft.inspection),
    certificates: draft.certificates ?? "",
    notes: draft.note ?? "",
    dims: draft.dims ?? "",
    customer: draft.customer ?? "",
    part_of: `Part ${partNo} of ${total}`,
  };
}

export function persistTravelerSlice(
  fields: TravelerFieldMap,
  detached: string[],
): { detached: string[]; values: TravelerFieldMap } {
  const keys = detached.filter((k) => LINKED.has(k)).sort();
  const values: TravelerFieldMap = {};
  for (const key of TRAVELER_ONLY_KEYS) {
    values[key] = fields[key] ?? "";
  }
  for (const key of keys) {
    values[key] = fields[key] ?? "";
  }
  return { detached: keys, values };
}
