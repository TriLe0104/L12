/** Shared helpers for rendering card fields from board settings. */

import type { BoardDocument, CardFieldConfig, CustomFieldConfig } from "./boardTypes";
import type { PODraft } from "./types";

export function visibleCardFields(doc: BoardDocument | null | undefined): CardFieldConfig[] {
  if (!doc) return [];
  return doc.cardFields.filter((f) => f.visible);
}

export function customFieldMap(doc: BoardDocument | null | undefined): Map<string, CustomFieldConfig> {
  const map = new Map<string, CustomFieldConfig>();
  for (const f of doc?.customFields ?? []) map.set(f.key, f);
  return map;
}

export function builtinValue(draft: PODraft, key: string): string {
  switch (key) {
    case "po_number":
      return draft.po_number ?? "—";
    case "part_number":
      return draft.part_number ?? "—";
    case "qty":
      return draft.qty != null ? String(draft.qty) : "—";
    case "dims":
      return draft.dims?.trim() || "—";
    case "mat_dim":
      return draft.mat_dim?.trim() || "—";
    case "material":
      return draft.material?.trim() || "—";
    case "finish":
      return draft.finish?.trim() || "—";
    case "inspection":
      return (draft.inspection ?? "standard").toUpperCase();
    case "hardware":
      return draft.hardware ? "YES" : "NO";
    case "priority":
      return (draft.priority_label ?? draft.priority ?? "—").toString().toUpperCase();
    case "customer":
      return draft.customer?.trim() || "—";
    case "owner":
      return draft.owner?.name ?? "Unassigned";
    default:
      return "—";
  }
}

export function builtinClass(key: string, draft: PODraft): string {
  if (key === "po_number" || key === "part_number" || key === "qty" || key === "dims") return "mono";
  if (key === "mat_dim") return "mono warn";
  if (key === "finish") return "go";
  if (key === "hardware") return draft.hardware ? "go" : "warn";
  return "";
}

export function customValue(
  draft: PODraft,
  key: string,
  meta?: CustomFieldConfig,
): string {
  const raw = draft.custom_fields?.[key];
  if (raw === null || raw === undefined || raw === "") return "—";
  if (meta?.type === "number") return String(raw);
  return String(raw);
}

/** Merge a custom field patch into the draft's custom_fields map. */
export function patchCustomField(
  draft: PODraft,
  key: string,
  value: string | number | null,
): Record<string, string | number | null> {
  return { ...(draft.custom_fields ?? {}), [key]: value };
}
