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
  const [dims, setDims] = useState("");
  const [matDim, setMatDim] = useState("");
  const [material, setMaterial] = useState("");
  const [finish, setFinish] = useState("");
  const [inspection, setInspection] = useState("standard");
  const [hardware, setHardware] = useState(false);
  const [priority, setPriority] = useState("normal");
  const [certificates, setCertificates] = useState("");
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
        part_number: pn,
        part_name: partName || pn,
        qty: Number(qty) || 1,
        dims: dims || undefined,
        mat_dim: matDim || undefined,
        material: material || undefined,
        finish: finish || undefined,
        inspection: inspection || undefined,
        hardware: hardware || false,
        priority: priority || "normal",
        certificates: certificates || undefined,
        thumbnail_url: thumbnail_url || undefined,
      };

      let saved: PurchaseOrder;
      if (record && (record as any).id) {
        // Append part to existing PO via dedicated endpoint
        saved = await api.addPart((record as any).id, payload);
      } else {
        // Create a new PO (create-on-collision still works) — include the minimal
        // job and po identifiers so the server can decide whether to append.
        const createPayload = {
          job_no: record?.job_no ?? "",
          po_number: record?.po_number ?? "",
          part_number: pn,
          qty: Number(qty) || 1,
          dims: dims || undefined,
          mat_dim: matDim || undefined,
          material: material || undefined,
          finish: finish || undefined,
          inspection: inspection || undefined,
          hardware: hardware || false,
          priority: priority || "normal",
          thumbnail_url: thumbnail_url || undefined,
        };
        saved = await api.createPO(createPayload as any);
      }

      onDone(saved, "Part added.");
      setPartNumber("");
      setPartName("");
      setQty(1);
      setDims("");
      setMatDim("");
      setMaterial("");
      setFinish("");
      setInspection("standard");
      setHardware(false);
      setPriority("normal");
      setCertificates("");
      setFile(null);
      setOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Add part failed");
    }
  }

  // Render as a small card-like form for better UX when expanded
  return open ? (
    <div style={{ border: "1px solid var(--rule)", padding: 12, borderRadius: 6, background: "#fff", display: "grid", gap: 8, width: 520 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ flex: 0 }}>Add part</strong>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: "0.9rem", color: "var(--steel)" }}>
          PO: <strong>{record?.po_number ?? "(new)"}</strong>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 6rem", gap: 8 }}>
        <input className="field" placeholder="Part #" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} />
        <input className="field" placeholder="Part name" value={partName} onChange={(e) => setPartName(e.target.value)} />
        <input className="field" placeholder="Qty" value={String(qty)} onChange={(e) => setQty(e.target.value === "" ? "" : Number(e.target.value))} />

        <input className="field" placeholder="Dims" value={dims} onChange={(e) => setDims(e.target.value)} />
        <input className="field" placeholder="Mat Dim" value={matDim} onChange={(e) => setMatDim(e.target.value)} />
        <select className="field" value={priority} onChange={(e) => setPriority(e.target.value)}> 
          <option value="hot">Hot</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>

        <input className="field" placeholder="Material" value={material} onChange={(e) => setMaterial(e.target.value)} />
        <input className="field" placeholder="Finish" value={finish} onChange={(e) => setFinish(e.target.value)} />
        <select className="field" value={inspection} onChange={(e) => setInspection(e.target.value)}>
          <option value="standard">Standard</option>
          <option value="formal">Formal</option>
          <option value="source">Source</option>
          <option value="none">None</option>
        </select>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={hardware} onChange={(e) => setHardware(e.target.checked)} /> Hardware
        </label>
        <input className="field" placeholder="Certificates" value={certificates} onChange={(e) => setCertificates(e.target.value)} />
        <div />

        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center" }}>
          <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)} />
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={() => void submit()}>Add</button>
            <button type="button" className="btn" onClick={() => { setOpen(false); setPartNumber(""); setPartName(""); setQty(1); setDims(""); setMatDim(""); setMaterial(""); setFinish(""); setInspection("standard"); setHardware(false); setPriority("normal"); setCertificates(""); setFile(null); }}>Cancel</button>
          </div>
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
