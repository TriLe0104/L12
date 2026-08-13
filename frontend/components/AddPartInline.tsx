"use client";

import { useState } from "react";
import type { PurchaseOrder } from "@/lib/types";
import { api } from "@/lib/api";

export default function AddPartInline({
  record,
  onStart,
  onDone,
  onError,
}: {
  record: PurchaseOrder;
  onStart: () => void;
  onDone: (saved: PurchaseOrder, note?: string) => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [partNumber, setPartNumber] = useState("");
  const [partName, setPartName] = useState("");
  const [qty, setQty] = useState<number | "">(1);
  const [file, setFile] = useState<File | null>(null);

  async function submit() {
    const pn = partNumber.trim();
    if (!pn) return onError("Part number is required");
    onStart();
    try {
      let thumbnail_url: string | undefined = undefined;
      if (file) {
        const upload = await api.uploadImage(file);
        thumbnail_url = upload.url;
      }
      const payload: any = {
        job_no: record.job_no,
        po_number: record.po_number,
        part_number: pn,
        part_name: partName || pn,
        qty: Number(qty) || 1,
        due_date: record.due_date,
        material: record.material,
        finish: record.finish,
        inspection: record.inspection,
        priority: record.priority,
      };
      if (thumbnail_url) payload.thumbnail_url = thumbnail_url;
      const saved = await api.createPO(payload);
      onDone(saved, "Part added.");
      setPartNumber("");
      setPartName("");
      setFile(null);
      setQty(1);
      setOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Add part failed");
    }
  }

  return open ? (
    <span style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: 8 }}>
      <input
        className="field"
        placeholder="Part #"
        value={partNumber}
        onChange={(e) => setPartNumber(e.target.value)}
        style={{ width: "8rem" }}
      />
      <input
        className="field"
        placeholder="Part name"
        value={partName}
        onChange={(e) => setPartName(e.target.value)}
        style={{ width: "8rem" }}
      />
      <input
        className="field"
        placeholder="Qty"
        value={String(qty)}
        onChange={(e) => setQty(e.target.value === "" ? "" : Number(e.target.value))}
        style={{ width: "4rem" }}
      />
      <input
        type="file"
        accept="image/*"
        onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
      />
      <button type="button" className="btn" onClick={() => void submit()}>
        Add
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => {
          setOpen(false);
          setPartNumber("");
          setPartName("");
          setQty(1);
          setFile(null);
        }}
      >
        Cancel
      </button>
    </span>
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
