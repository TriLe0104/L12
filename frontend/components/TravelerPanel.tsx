"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "@/lib/api";
import { useBoardSettings } from "@/lib/boardSettings";
import { MATERIAL_FIELD_KEY, selectionOptions } from "@/lib/boardTypes";
import {
  isCardLinkedTravelerKey,
  persistTravelerSlice,
  type TravelerFieldMap,
} from "@/lib/traveler";
import { MaterialCombobox } from "./MaterialCombobox";

type FieldMap = TravelerFieldMap;
type PacketFmt = "pdf" | "docx" | "xlsx";

const EDIT_FIELDS: { key: string; label: string; multiline?: boolean }[] = [
  { key: "work_order", label: "Work order #" },
  { key: "due_date", label: "Due date" },
  { key: "mat_dim", label: "Material dims" },
  { key: "sign", label: "Sign / created by" },
  { key: "po_number", label: "Customer PO #" },
  { key: "part_name", label: "Part name" },
  { key: "part_number", label: "Part #" },
  { key: "qty", label: "Quantity" },
  { key: "finish", label: "Finish" },
  { key: "inserts", label: "Inserts" },
  { key: "material", label: "Material" },
  { key: "material_spec", label: "Material specification" },
  { key: "inspection", label: "Inspection" },
  { key: "part_marking", label: "Part marking" },
  { key: "certificates", label: "Certificates" },
  { key: "dims", label: "Stock dims" },
  { key: "part_of", label: "Part of" },
  { key: "customer", label: "Customer" },
  { key: "programmer", label: "Programmer" },
  { key: "program_date", label: "Program date" },
  { key: "notes", label: "Notes", multiline: true },
];

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Editable traveler packet: preview PDF in-app, download PDF / Word / Excel. */
export function TravelerPanel({
  poId,
  jobNo,
  part,
  partCount = 0,
  canEditDraft,
  cardSource,
  onGenerated,
}: {
  poId: string;
  jobNo: string;
  /** 1-based part number. Omit for a single-part order. */
  part?: number;
  partCount?: number;
  /** Manager+ on an unlocked order — may persist traveler_draft. */
  canEditDraft: boolean;
  /** Live job-card values for linked fields. */
  cardSource?: FieldMap;
  /** Refresh activity after a logged generate. */
  onGenerated?: () => void;
}) {
  const [fields, setFields] = useState<FieldMap>({});
  const [baseline, setBaseline] = useState<FieldMap>({});
  const [detached, setDetached] = useState<string[]>([]);
  const [baselineDetached, setBaselineDetached] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadFmt, setDownloadFmt] = useState<PacketFmt | null>(null);
  const [downloadElapsedMs, setDownloadElapsedMs] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewElapsedMs, setPreviewElapsedMs] = useState(0);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const previewStartedRef = useRef<number | null>(null);
  const downloadStartedRef = useRef<number | null>(null);
  const { document: boardDocument } = useBoardSettings();
  const materialOptions = selectionOptions(boardDocument, MATERIAL_FIELD_KEY);
  const fieldsRef = useRef<FieldMap>({});
  const detachedRef = useRef<string[]>([]);
  const dirtyRef = useRef(false);

  const dirty = useMemo(
    () =>
      JSON.stringify(persistTravelerSlice(fields, detached)) !==
      JSON.stringify(persistTravelerSlice(baseline, baselineDetached)),
    [fields, detached, baseline, baselineDetached],
  );
  fieldsRef.current = fields;
  detachedRef.current = detached;
  dirtyRef.current = dirty;

  const displayOf = useCallback(
    (key: string) => {
      if (isCardLinkedTravelerKey(key) && !detached.includes(key) && cardSource) {
        const live = cardSource[key];
        if (live !== undefined && live !== null) return live;
      }
      return fields[key];
    },
    [cardSource, detached, fields],
  );

  const downloading = downloadFmt != null;
  const actionsLocked = downloading || previewing;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const trav = await api.getTraveler(poId, part);
      setFields(trav.fields);
      setBaseline(trav.fields);
      const nextDetached = trav.detached ?? [];
      setDetached(nextDetached);
      setBaselineDetached(nextDetached);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load traveler");
    } finally {
      setLoading(false);
    }
  }, [poId, part]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (dirtyRef.current && canEditDraft) {
        void api.saveTraveler(poId, fieldsRef.current, part, detachedRef.current).catch(() => {
          /* unmount flush — the next load is the source of truth */
        });
      }
    };
  }, [poId, part, canEditDraft]);

  useEffect(() => {
    return () => {
      previewAbortRef.current?.abort();
      downloadAbortRef.current?.abort();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!previewing) return;
    previewStartedRef.current = Date.now();
    setPreviewElapsedMs(0);
    const id = window.setInterval(() => {
      const started = previewStartedRef.current;
      if (started != null) setPreviewElapsedMs(Date.now() - started);
    }, 250);
    return () => window.clearInterval(id);
  }, [previewing]);

  useEffect(() => {
    if (!downloading) return;
    downloadStartedRef.current = Date.now();
    setDownloadElapsedMs(0);
    const id = window.setInterval(() => {
      const started = downloadStartedRef.current;
      if (started != null) setDownloadElapsedMs(Date.now() - started);
    }, 250);
    return () => window.clearInterval(id);
  }, [downloading]);

  const closePreview = useCallback(() => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPreviewing(false);
    setPreviewOpen(false);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const cancelDownload = useCallback(() => {
    downloadAbortRef.current?.abort();
    downloadAbortRef.current = null;
    setDownloadFmt(null);
    setNote("Download cancelled.");
  }, []);

  useEffect(() => {
    if (!previewOpen) return;

    const root = document.documentElement;
    const gap = window.innerWidth - root.clientWidth;
    const previous = { overflow: root.style.overflow, padding: root.style.paddingRight };
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      closePreview();
    };

    root.style.overflow = "hidden";
    if (gap > 0) root.style.paddingRight = `${gap}px`;
    previewCloseRef.current?.focus();
    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      root.style.overflow = previous.overflow;
      root.style.paddingRight = previous.padding;
      opener?.focus?.();
    };
  }, [closePreview, previewOpen]);

  const patch = (key: string, value: string) => {
    setNote(null);
    setFields((prev) => ({
      ...prev,
      [key]: key === "qty" ? (value === "" ? "" : Number(value) || value) : value,
    }));
  };

  const toggleOverride = (key: string) => {
    if (!canEditDraft || !isCardLinkedTravelerKey(key)) return;
    setNote(null);
    if (detached.includes(key)) {
      setDetached((prev) => prev.filter((k) => k !== key));
      return;
    }
    setFields((prev) => ({ ...prev, [key]: displayOf(key) ?? "" }));
    setDetached((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  async function saveDraft() {
    if (!canEditDraft) return;
    const snap = fieldsRef.current;
    const snapDetached = detachedRef.current;
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveTraveler(poId, snap, part, snapDetached);
      if (
        JSON.stringify(persistTravelerSlice(fieldsRef.current, detachedRef.current)) ===
        JSON.stringify(persistTravelerSlice(snap, snapDetached))
      ) {
        setFields(res.fields);
        setBaseline(res.fields);
        const nextDetached = res.detached ?? [];
        setDetached(nextDetached);
        setBaselineDetached(nextDetached);
      } else {
        setBaseline(snap);
        setBaselineDetached(snapDetached);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!canEditDraft || !dirty || loading) return;
    const id = window.setTimeout(() => {
      void saveDraft();
    }, 700);
    return () => window.clearTimeout(id);
  }, [fields, dirty, canEditDraft, loading, poId, part]);

  async function openPreview() {
    // Cancel any in-flight preview so re-clicks don't stack work.
    previewAbortRef.current?.abort();
    const ac = new AbortController();
    previewAbortRef.current = ac;

    setError(null);
    setNote(null);
    // Open modal immediately — never wait on the network/COM path first.
    setPreviewOpen(true);
    setPreviewing(true);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    try {
      if (canEditDraft && dirty) {
        const res = await api.saveTraveler(poId, fields, part, detached);
        if (ac.signal.aborted) return;
        setFields(res.fields);
        setBaseline(res.fields);
        const nextDetached = res.detached ?? [];
        setDetached(nextDetached);
        setBaselineDetached(nextDetached);
      }
      // GET /traveler/pdf → same template-overlay PDF as Download.
      const { blob } = await api.previewTraveler(poId, "pdf", { part, signal: ac.signal });
      if (ac.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      setError(err instanceof Error ? err.message : "Preview failed");
      setPreviewOpen(false);
    } finally {
      if (previewAbortRef.current === ac) {
        setPreviewing(false);
        previewAbortRef.current = null;
      }
    }
  }

  async function download(fmt: PacketFmt) {
    downloadAbortRef.current?.abort();
    const ac = new AbortController();
    downloadAbortRef.current = ac;

    setDownloadFmt(fmt);
    setError(null);
    setNote(
      fmt === "pdf"
        ? "Preparing PDF…"
        : `Preparing ${fmt.toUpperCase()}…`,
    );
    try {
      const liveFields = { ...fields };
      for (const key of Object.keys(cardSource ?? {})) {
        if (!detached.includes(key)) liveFields[key] = displayOf(key) ?? liveFields[key];
      }
      const { blob, filename } = await api.generateTraveler(
        poId,
        fmt,
        { fields: liveFields, detached, persist: canEditDraft },
        { part, signal: ac.signal },
      );
      if (ac.signal.aborted) return;
      triggerDownload(blob, filename);
      if (canEditDraft) {
        const res = await api.getTraveler(poId, part);
        if (ac.signal.aborted) return;
        setFields(res.fields);
        setBaseline(res.fields);
        const nextDetached = res.detached ?? [];
        setDetached(nextDetached);
        setBaselineDetached(nextDetached);
      }
      setNote(`Downloaded ${fmt.toUpperCase()} for ${jobNo}.`);
      onGenerated?.();
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      setError(err instanceof Error ? err.message : "Download failed");
      setNote(null);
    } finally {
      if (downloadAbortRef.current === ac) {
        setDownloadFmt(null);
        downloadAbortRef.current = null;
      }
    }
  }

  if (loading) {
    return (
      <section className="traveler-panel" aria-busy="true">
        <div className="section-label">Traveler</div>
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          Loading traveler fields…
        </p>
      </section>
    );
  }

  return (
    <section className="traveler-panel">
      <div className="section-label">
        Traveler packet
        {part && partCount > 0 ? ` · Part ${part} of ${partCount}` : ""}
      </div>

      <div className="traveler-meta">
        <span>
          Generated <strong>{String(fields.generated_at ?? "—")}</strong>
        </span>
        <span>
          by <strong>{String(fields.generated_by || "—")}</strong>
        </span>
        <span>
          Order created by <strong>{String(fields.created_by || "—")}</strong>
        </span>
      </div>

      <div className="traveler-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={actionsLocked}
          aria-busy={previewing}
          onClick={() => void openPreview()}
        >
          {previewing ? "Generating preview…" : "Preview PDF"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={actionsLocked}
          aria-busy={downloadFmt === "pdf"}
          onClick={() => void download("pdf")}
        >
          {downloadFmt === "pdf" ? "Preparing PDF…" : "Download PDF"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={actionsLocked}
          onClick={() => void download("docx")}
        >
          Word
        </button>
        <button
          type="button"
          className="btn"
          disabled={actionsLocked}
          onClick={() => void download("xlsx")}
        >
          Excel
        </button>
        {canEditDraft && (dirty || saving) && (
          <span className="traveler-autosave" role="status">
            Saving…
          </span>
        )}
      </div>

      {downloading && (
        <div className="traveler-progress" role="status" aria-live="polite">
          <span>
            {downloadFmt === "pdf"
              ? "Preparing PDF…"
              : `Preparing ${downloadFmt?.toUpperCase()}…`}{" "}
            <strong>{formatElapsed(downloadElapsedMs)}</strong>
          </span>
          <button type="button" className="btn" onClick={cancelDownload}>
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && !downloading && (
        <p className="traveler-note" role="status">
          {note}
        </p>
      )}

      <div className="traveler-grid">
        {EDIT_FIELDS.map((f) => {
          const linked = isCardLinkedTravelerKey(f.key);
          const overridden = detached.includes(f.key);
          const linkedToCard = linked && !overridden;
          const value = String(displayOf(f.key) ?? "");
          const locked = !canEditDraft || linkedToCard;
          return (
            <label key={f.key} className={f.multiline ? "traveler-span" : undefined}>
              <span className="traveler-field-head">
                <span>{f.label}</span>
                {linked && canEditDraft && (
                  <button
                    type="button"
                    className="traveler-override"
                    data-on={overridden ? "true" : "false"}
                    onClick={() => toggleOverride(f.key)}
                  >
                    {overridden ? "Follow card" : "Override"}
                  </button>
                )}
              </span>
              {f.multiline ? (
                <textarea
                  className="cell-input"
                  rows={3}
                  value={value}
                  disabled={locked}
                  onChange={(e) => patch(f.key, e.target.value)}
                />
              ) : f.key === "material" ? (
                <MaterialCombobox
                  value={value || null}
                  disabled={locked}
                  options={materialOptions}
                  onChange={(material) => patch("material", material ?? "")}
                />
              ) : (
                <input
                  className="cell-input"
                  value={value}
                  disabled={locked}
                  onChange={(e) => patch(f.key, e.target.value)}
                />
              )}
            </label>
          );
        })}
      </div>

      {previewOpen &&
        createPortal(
          <div
            className="scrim traveler-preview-scrim"
            onClick={(event) => {
              event.stopPropagation();
              if (event.target === event.currentTarget) closePreview();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div
              className="traveler-preview-dialog"
              role="dialog"
              aria-modal="true"
              aria-busy={previewing}
              aria-label={`Traveler PDF preview for ${jobNo}`}
            >
              <header className="traveler-preview-head">
                <strong>Traveler PDF · {jobNo}</strong>
                {previewUrl && (
                  <a className="btn" href={previewUrl} target="_blank" rel="noreferrer">
                    Open tab
                  </a>
                )}
              </header>
              {previewUrl ? (
                <object
                  title="Traveler PDF preview"
                  data={previewUrl}
                  type="application/pdf"
                  className="traveler-preview-frame"
                >
                  <p className="muted" style={{ padding: "1rem" }}>
                    PDF preview unavailable in this browser.{" "}
                    <a href={previewUrl} target="_blank" rel="noreferrer">
                      Open the PDF
                    </a>
                    .
                  </p>
                </object>
              ) : (
                <div className="traveler-preview-loading" role="status">
                  <p>Generating preview…</p>
                  <p className="muted">{formatElapsed(previewElapsedMs)}</p>
                </div>
              )}
              <p className="muted traveler-preview-footnote">
                {previewUrl
                  ? "Original Traveler + Part 555 + Program sheet layouts."
                  : "Preparing template preview…"}
              </p>
              <button
                ref={previewCloseRef}
                type="button"
                className="image-viewer-close"
                onClick={closePreview}
                aria-label="Close traveler PDF preview"
                title="Close (Esc)"
              >
                ×
              </button>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
