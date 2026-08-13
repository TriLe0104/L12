"use client";

import { useEffect, useState } from "react";
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

  async function submitFromDraft() {
    if (!draft) return onError("No draft to submit");
    const pn = (draft.part_number ?? "").trim();
    if (!pn) return onError("Part number is required");
    onStart();
    try {
      // If a file is present in the outer control, upload it first; CardEditor
      // also supports uploading via its own well but keep parity.
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
          thumbnail_url: thumbnail_url || undefined,
        };

      let saved: PurchaseOrder;
      if (record && (record as any).id) {
        saved = await api.addPart((record as any).id, payload);
      } else {
        const createPayload = {
          job_no: draft.job_no ?? record?.job_no ?? "",
          po_number: draft.po_number ?? record?.po_number ?? "",
          ...payload,
        };
        saved = await api.createPO(createPayload as any);
      }

      onDone(saved, "Part added.");
      setDraft(null);
      setFile(null);
      setOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Add part failed");
    }
  }

  useEffect(() => {
    if (!open) return;
    // initialize a draft that mirrors the create PO card but with the parent
    // record's job/po fields pre-filled. Hide PO# in the editor via hideFields.
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
      thumbnail_url: record?.thumbnail_url ?? null,
      model_url: null,
      model_filename: null,
      model_size: null,
      custom_fields: {},
    });
  }, [open, record]);

  // Render CardEditor for the same new-order UI but hide the PO # field
  return open && draft ? (
    <div style={{ border: "1px solid var(--rule)", padding: 12, borderRadius: 6, background: "#fff", width: 560 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ flex: 0 }}>Add part</strong>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: "0.9rem", color: "var(--steel)" }}>
          PO: <strong>{record?.po_number ?? "(new)"}</strong>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <CardEditor
          value={draft}
          onChange={(patch) => setDraft((d) => ({ ...(d ?? {}), ...patch }))}
          statuses={statuses}
          hideFields={["po_number"]}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button type="button" className="btn" onClick={() => void submitFromDraft()}>Add</button>
          <button type="button" className="btn" onClick={() => { setOpen(false); setDraft(null); setFile(null); }}>Cancel</button>
        </div>
      </div>
    </div>
  ) : (
    <button
      type="button"
      className="btn"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
      }}
      style={{ marginLeft: 8 }}
      title="Add a new part to this PO"
    >
      + Part
    </button>
  );
}
