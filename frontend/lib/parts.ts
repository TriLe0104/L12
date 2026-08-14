import type { PurchaseOrder } from "./types";

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
    display_part_index: i,
  };
}
