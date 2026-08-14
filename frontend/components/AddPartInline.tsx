"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PurchaseOrder, PODraft, StatusMeta } from "@/lib/types";
import { api } from "@/lib/api";
import { CardEditor } from "./CardEditor";

export default function AddPartInline({
  record,
  onStart,
  onDone,
  onError,
  statuses,
}: {
  record: PurchaseOrder;
  onStart: () => void;
  onDone: (saved: PurchaseOrder, note?: string) => void;
  onError: (msg: string) => void;
  statuses: StatusMeta[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PODraft | null>(null);
  const [file, setFile] = useState<File | null>(null);

  function close() {
    setOpen(false);
    setDraft(null);
    setFile(null);
  }

  async function submitFromDraft() {
    if (!draft) return onError("No draft to submit");
    const pn = (draft.part_number ?? "").trim();
    if (!pn) return onError("Part number is required");
    onStart();
    try {
      let thumbnail_url = draft.thumbnail_url ?? undefined;
      if (file) {
        const upload = await api.uploadImage(file);
        thumbnail_url = upload.url;
      }

      const d: any = draft as any;
      const payload: any = {
        part_number: pn,
        part_name: d.part_name || pn,
        qty: Number(d.qty) || 1,
        dims: d.dims || undefined,
        mat_dim: d.mat_dim || undefined,
        material: d.material || undefined,
        finish: d.finish || undefined,
        inspection: d.inspection || undefined,
        hardware: d.hardware || false,
        priority: d.priority || "normal",
        certificates: d.certificates || undefined,
        thumbnail_url: thumbnail_url || null,
        model_url: d.model_url || null,
        model_filename: d.model_filename || null,
        model_size: d.model_size || null,
      };

      let saved: PurchaseOrder;
      if (record?.id) {
        saved = await api.addPart(record.id, payload);
        try {
          saved = await api.getPO(saved.id);
        } catch {
          /* use what we already have */
        }
      } else {
        const createPayload = {
          job_no: draft.job_no ?? record?.job_no ?? "",
          po_number: draft.po_number ?? record?.po_number ?? "",
          ...payload,
        };
        saved = await api.createPO(createPayload as any);
      }

      onDone(saved, "Part added.");
      close();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Add part failed");
    }
  }

  useEffect(() => {
    if (!open) return;
    setDraft({
      job_no: record?.job_no ?? "",
      po_number: record?.po_number ?? "",
      part_number: "",
      part_name: "",
      qty: 1,
      due_date: record?.due_date ?? undefined,
      dims: "",
      mat_dim: "",
      material: "",
      finish: "",
      inspection: "standard",
      hardware: false,
      status: "need_material_size",
      priority: "normal",
      note: "",
      thumbnail_url: null,
      model_url: null,
      model_filename: null,
      model_size: null,
      custom_fields: {},
    } as any);
  }, [open, record]);

  if (!open || !draft) {
    return (
      <button
        type="button"
        className="btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Add a new part to this PO"
      >
        + Part
      </button>
    );
  }

  const modal = (
    <div
      className="scrim add-part-scrim"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="add-part-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add part"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="add-part-modal-head">
          <span
            className="add-part-title"
            style={{
              display: "inline-block",
              whiteSpace: "nowrap",
              writingMode: "horizontal-tb",
              textOrientation: "mixed",
              overflowWrap: "normal",
              wordBreak: "keep-all",
              flex: "0 0 auto",
              width: "max-content",
              minWidth: "max-content",
              fontWeight: 700,
              letterSpacing: "-0.02em",
            }}
          >
            Add part
          </span>
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
        </header>

        <div style={{ marginTop: 8 }}>
          <CardEditor
            value={draft}
            onChange={(patch) => setDraft((d) => ({ ...(d ?? {}), ...patch }))}
            statuses={statuses}
            hideFields={["po_number"]}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn" onClick={() => void submitFromDraft()}>
              Add
            </button>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
