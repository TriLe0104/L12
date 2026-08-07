/** Shared helpers for rendering card fields from board settings. */

import {
  resolveCardFieldType,
  type BoardDocument,
  type CardFieldConfig,
  type CustomFieldConfig,
  type CustomFieldType,
} from "./boardTypes";
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

export { resolveCardFieldType };
export type { CustomFieldType };

/** String form of a builtin PO column for generic text/date/number editors. */
export function builtinRawString(draft: PODraft, key: string): string {
  switch (key) {
    case "po_number":
      return draft.po_number ?? "";
    case "part_number":
      return draft.part_number ?? "";
    case "qty":
      return draft.qty != null ? String(draft.qty) : "";
    case "dims":
      return draft.dims ?? "";
    case "mat_dim":
      return draft.mat_dim ?? "";
    case "material":
      return draft.material ?? "";
    case "finish":
      return draft.finish ?? "";
    case "inspection":
      return (draft.inspection ?? "").toString();
    case "priority":
      return (draft.priority ?? "").toString();
    case "customer":
      return draft.customer ?? "";
    default:
      return "";
  }
}

/** Patch a builtin column from a generic editor value (keeps writing PO columns). */
export function patchBuiltinScalar(
  key: string,
  raw: string,
  type: CustomFieldType,
): PODraft {
  if (key === "qty") {
    const n = Number(raw);
    return { qty: Number.isFinite(n) && n > 0 ? n : 1 };
  }
  if (key === "po_number") return { po_number: raw };
  if (key === "part_number") return { part_number: raw };
  if (key === "dims") return { dims: raw };
  if (key === "mat_dim") return { mat_dim: raw };
  if (key === "material") return { material: raw || null };
  if (key === "finish") return { finish: raw || null };
  if (key === "inspection") return { inspection: raw || "standard" };
  if (key === "priority") return { priority: raw || "normal" };
  if (key === "customer") return { customer: raw || null };
  void type;
  return {};
}

export function builtinInputClass(key: string): string {
  if (key === "po_number" || key === "part_number" || key === "qty" || key === "dims") {
    return "cell-input mono";
  }
  if (key === "mat_dim") return "cell-input mono warn";
  if (key === "finish") return "cell-input go";
  return "cell-input";
}

export function builtinPlaceholder(key: string): string | undefined {
  if (key === "dims") return "0.905 x 0.870 x 0.345in";
  if (key === "mat_dim") return "1.25 x 1.7 x .500";
  if (key === "finish") return "CLEAR ANODIZE; CHEM FILM GOLD";
  if (key === "customer") return "Program or customer";
  return undefined;
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
