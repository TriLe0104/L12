import { PRIORITY_ORDER, type PurchaseOrder } from "./types";

export function highestPriority(
  po: PurchaseOrder,
  order: string[] = PRIORITY_ORDER,
): string {
  const parts = po.parts ?? [];
  if (parts.length < 2) return po.priority;
  const rank = (value: string) => {
    const i = order.findIndex((o) => o.toLowerCase() === value.toLowerCase());
    return i < 0 ? order.length : i;
  };
  let best = po.priority || "normal";
  let bestRank = rank(best);
  for (const part of parts) {
    const value = part.priority || po.priority || "normal";
    const r = rank(value);
    if (r < bestRank) {
      best = value;
      bestRank = r;
    }
  }
  return best;
}

export function displayPartIndex(po: PurchaseOrder): number {
  const n = po.parts?.length ?? 0;
  if (n === 0) return 0;
  const idx = po.display_part_index ?? 0;
  if (!Number.isFinite(idx)) return 0;
  return Math.min(Math.max(Math.trunc(idx), 0), n - 1);
}

/** Overlay one part's fields onto the PO so a JobCard can render that face. */
export function poShowingPart(po: PurchaseOrder, index?: number): PurchaseOrder {
  const parts = po.parts ?? [];
  if (parts.length === 0) return po;
  const i = index ?? displayPartIndex(po);
  const p = parts[i] ?? {};
  const inheritMedia = i === 0 && !Object.prototype.hasOwnProperty.call(p, "thumbnail_url");
  const inheritModel = i === 0 && !Object.prototype.hasOwnProperty.call(p, "model_url");
  return {
    ...po,
    part_number: p.part_number ?? po.part_number,
    qty: p.qty ?? po.qty,
    dims: p.dims ?? po.dims,
    mat_dim: p.mat_dim ?? po.mat_dim,
    material: p.material ?? po.material,
    finish: p.finish ?? po.finish,
    inspection: p.inspection ?? po.inspection,
    hardware: p.hardware ?? po.hardware,
    priority: p.priority ?? po.priority,
    certificates: Object.prototype.hasOwnProperty.call(p, "certificates")
      ? (p.certificates ?? null)
      : i === 0
        ? (po.certificates ?? null)
        : null,
    status: (p.status as PurchaseOrder["status"]) ?? (i === 0 ? po.status : po.status),
    note: Object.prototype.hasOwnProperty.call(p, "note")
      ? (p.note ?? "")
      : i === 0
        ? (po.note ?? "")
        : "",
    custom_fields:
      p.custom_fields && typeof p.custom_fields === "object"
        ? { ...p.custom_fields }
        : i === 0
          ? { ...(po.custom_fields ?? {}) }
          : {},
    thumbnail_url: inheritMedia ? po.thumbnail_url : (p.thumbnail_url ?? null),
    model_url: inheritModel ? po.model_url : (p.model_url ?? null),
    model_filename: inheritModel ? po.model_filename : (p.model_filename ?? null),
    model_size: inheritModel ? po.model_size : (p.model_size ?? null),
    body_color: Object.prototype.hasOwnProperty.call(p, "body_color")
      ? (p.body_color ?? null)
      : i === 0
        ? (po.body_color ?? null)
        : null,
    secondary_status: Object.prototype.hasOwnProperty.call(p, "secondary_status")
      ? (p.secondary_status ?? null)
      : i === 0
        ? (po.secondary_status ?? null)
        : null,
    display_part_index: i,
  };
}
