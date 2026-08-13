"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import AddPartInline from "./AddPartInline";
import {
  canEdit,
  canEditStatus,
  canModifyPO,
  canModifyStatus,
  LOCKED_REASON,
  useAuth,
} from "@/lib/auth";
import { changedFields } from "@/lib/dirty";
import type { ActivityItem, PODraft, PurchaseOrder, StatusMeta } from "@/lib/types";
import { ActivityList } from "./ActivityList";
import { CardEditor } from "./CardEditor";
import { CommentThread } from "./CommentThread";
import { LockGlyph } from "./JobCard";
import { TravelerPanel } from "./TravelerPanel";
import { UnsavedChangesPrompt } from "./UnsavedChangesPrompt";

/** Today in the shop's own timezone. `toISOString()` would report the UTC day,
 *  which is off by one for most of the working day. */
const todayLocal = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

const blank = (defaults: PODraft = {}): PODraft => ({
  job_no: "",
  po_number: "",
  part_number: "",
  qty: 1,
  due_date: todayLocal(),
  dims: "",
  mat_dim: "",
  material: "",
  finish: "",
  inspection: "standard",
  hardware: false,
  status: "need_material_size",
  priority: "normal",
  customer: "",
  note: "",
  thumbnail_url: null,
  model_url: null,
  model_filename: null,
  model_size: null,
  custom_fields: {},
  ...defaults,
});

export function PODrawer({
  po,
  mode,
  statuses,
  defaults,
  onClose,
  onSaved,
  onDeleted,
  onCommentCountChange,
}: {
  po: PurchaseOrder | null;
  mode: "view" | "create";
  statuses: StatusMeta[];
  defaults?: Partial<PurchaseOrder>;
  onClose: () => void;
  onSaved: (po: PurchaseOrder) => void;
  onDeleted: (id: string) => void;
  /** Dashboard badge refresh when a note is posted from the drawer. */
  onCommentCountChange?: (poId: string, count: number) => void;
}) {
  const { user } = useAuth();
  const editable = canEdit(user);
  const statusCapable = canEditStatus(user);
  // the record the drawer is currently attached to; a create turns into this one's edit view
  const [record, setRecord] = useState<PurchaseOrder | null>(po);
  // A new order starts out owned by whoever is filling it in — the same default
  // the server applies — so the picker states it instead of implying nothing.
  const newDraft = (): PODraft => blank({ owner_id: user?.id ?? null, ...defaults });
  const [draft, setDraft] = useState<PODraft>(po ?? newDraft());
  /** What the draft is measured against: the record as last stored, or — for a
   *  create — the empty form as it was first handed over. Reset on every
   *  successful save, because the drawer stays open on the saved record and the
   *  changes are no longer unsaved. */
  const [baseline, setBaseline] = useState<PODraft>(draft);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const creating = mode === "create" && !record;
  // the lock applies to the record as stored, not to the unsaved draft
  const modifiable = editable && (creating || canModifyPO(user, record));
  // User (and above) may flip status on an unlocked order without full edit rights
  const statusEditable = !creating && canModifyStatus(user, record);
  const statusOnly = statusEditable && !modifiable;

  const changed = useMemo(() => changedFields(baseline, draft), [baseline, draft]);
  /* Someone who may not change this order meets a form of disabled fields, so it
     can never reach a dirty state — but the guard says so itself rather than
     leaning on that, or a stray programmatic edit would trap them behind a
     prompt whose Save can only 403. Status-only actors dirty solely on status. */
  const dirty = modifiable
    ? changed.length > 0
    : statusOnly && changed.includes("status");
  const canSave = modifiable || (statusOnly && dirty);

  const loadActivity = (id: string) =>
    api.poActivity(id).then(setActivity).catch(() => setActivity([]));

  const [selectedPartIndex, setSelectedPartIndex] = useState<number | null>(null);

  function mergePartIntoDraft(rec: PODraft | PurchaseOrder | null, idx: number | null) {
    if (!rec || idx == null) return rec ?? newDraft();
    const parts = (rec as any).parts ?? [];
    if (!Array.isArray(parts) || parts.length === 0) return rec as PODraft;
    const p = parts[idx] ?? {};
    return {
      ...(rec as any),
      part_number: p.part_number ?? (rec as any).part_number,
      // part_name is not part of PO top-level but CardEditor / traveler may use it
      part_name: p.part_name ?? p.part_number ?? (rec as any).part_name,
      qty: p.qty ?? (rec as any).qty,
      dims: p.dims ?? (rec as any).dims,
      mat_dim: p.mat_dim ?? (rec as any).mat_dim,
      material: p.material ?? (rec as any).material,
      finish: p.finish ?? (rec as any).finish,
      inspection: p.inspection ?? (rec as any).inspection,
      hardware: p.hardware ?? (rec as any).hardware,
      priority: p.priority ?? (rec as any).priority,
      thumbnail_url: p.thumbnail_url ?? (rec as any).thumbnail_url,
    } as PODraft;
  }

  useEffect(() => {
    const opened = po ?? newDraft();
    setRecord(po);
    // default selected part to first part if present
    const partsCount = Array.isArray(po?.parts) ? po!.parts!.length : 0;
    const defaultIdx = partsCount > 0 ? 0 : null;
    setSelectedPartIndex(defaultIdx);
    const draftValue = mergePartIntoDraft(opened, defaultIdx);
    setDraft(draftValue);
    // one object for both, so a freshly opened form is never dirty against a
    // second blank built a millisecond later
    setBaseline(draftValue);
    setError(null);
    setSavedNote(null);
    setConfirming(false);
    if (po) void loadActivity(po.id);
    else setActivity([]);
    // defaults is a fresh object per render; keying off the id is enough
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po, mode]);

  /** Every way out of the drawer comes through here, so the guard cannot be
   *  bypassed by whichever dismissal the user happens to reach for. */
  const requestClose = useCallback(() => {
    if (dirty) setConfirming(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  async function save(): Promise<boolean> {
    if (!draft.job_no?.trim() || !draft.po_number?.trim() || !draft.part_number?.trim()) {
      setError("Job #, PO # and Part # are required");
      return false;
    }
    // `min` on the date input only blocks the picker, so a typed-in past date
    // still has to be caught here. Creates only: overdue POs stay saveable.
    if (creating) {
      const today = todayLocal();
      if (!draft.due_date) {
        setError("A due date is required");
        return false;
      }
      if (draft.due_date < today) {
        setError(`Due date can't be in the past — pick ${today} or later`);
        return false;
      }
    }
    setBusy(true);
    setError(null);
    setSavedNote(null);
    try {
      // Status-only actors send just status — never the whole draft — so a stray
      // disabled-field echo cannot widen the PATCH past what the server allows.
      const saved = creating
        ? await api.createPO({ ...draft, qty: Number(draft.qty) || 1 })
        : statusOnly
          ? await api.updatePO(record!.id, { status: draft.status })
            : (async () => {
                // If a part is selected, persist part-specific fields to the parts list
                if (record && selectedPartIndex != null) {
                  const partPayload: Record<string, any> = {
                    part_number: draft.part_number,
                    part_name: (draft as any).part_name ?? draft.part_number,
                    qty: Number(draft.qty) || 1,
                    dims: draft.dims || undefined,
                    mat_dim: draft.mat_dim || undefined,
                    material: draft.material || undefined,
                    finish: draft.finish || undefined,
                    inspection: draft.inspection || undefined,
                    hardware: !!draft.hardware,
                    priority: draft.priority || undefined,
                    certificates: (draft as any).certificates || undefined,
                    thumbnail_url: draft.thumbnail_url || undefined,
                  };
                  // PATCH the part first
                  await api.patchPart(record.id, selectedPartIndex, partPayload);
                }
                // Then update the PO-level fields
                return await api.updatePO(record!.id, { ...draft, qty: Number(draft.qty) || 1 });
              })();
      // stay open on the saved record: server-derived fields (stage, labels) come back here
      setRecord(saved);
      setDraft(saved);
      // the drawer staying open is exactly why this has to move: without it the
      // next click on the scrim would ask about changes already written
      setBaseline(saved);
      setSavedNote(creating ? "Created." : "Saved.");
      onSaved(saved);
      await loadActivity(saved.id);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Save from inside the prompt. A refused save — a 403 on a locked order, a
   *  validation message, a dead network — must not close anything: the prompt
   *  steps aside and leaves the drawer holding the edits and the reason. */
  async function saveAndClose() {
    if (await save()) onClose();
    else setConfirming(false);
  }

  async function remove() {
    if (!record || !window.confirm(`Delete ${record.job_no} · ${record.po_number}?`)) return;
    await api.deletePO(record.id);
    onDeleted(record.id);
  }

  return (
    <>
      <div className="scrim" onClick={requestClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-label="Purchase order detail"
        data-dirty={dirty}
      >
        <header className="drawer-head">
          <strong style={{ letterSpacing: "-0.02em" }}>
            {creating ? "New purchase order" : `${record?.job_no} · ${record?.po_number}`}
          </strong>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {record && Array.isArray(record.parts) && record.parts.length > 0 && (
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                Part
                <select
                  value={selectedPartIndex ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : Number(e.target.value);
                    setSelectedPartIndex(v);
                    const merged = mergePartIntoDraft(record, v);
                    setDraft(merged);
                    setBaseline(merged);
                  }}
                >
                  {(record.parts ?? []).map((p: any, i: number) => (
                    <option key={i} value={i}>{`Part ${i + 1} of ${ (record.parts?.length ?? (record.parts ? record.parts.length : 0)) } · ${p.part_number ?? p.part_name ?? "(unnamed)"}`}</option>
                  ))}
                </select>
              </label>
            )}

            {record && editable && (
              <AddPartInline
                record={record}
                statuses={statuses}
                onStart={() => setBusy(true)}
                onDone={async (saved, note) => {
                  setBusy(false);
                  setRecord(saved);
                  // if new part added, select the last part
                  const partsCount = Array.isArray(saved.parts) ? saved.parts.length : 0;
                  const idx = partsCount > 0 ? partsCount - 1 : null;
                  setSelectedPartIndex(idx);
                  const merged = mergePartIntoDraft(saved, idx);
                  setDraft(merged);
                  setBaseline(merged);
                  setSavedNote(note ?? "Part added.");
                  onSaved(saved);
                  await loadActivity(saved.id);
                }}
                onError={(msg) => {
                  setBusy(false);
                  setError(msg);
                }}
              />
            )}
          </div>
          <button className="btn" style={{ marginLeft: record && editable ? 8 : "auto" }} onClick={requestClose}>
            Close
          </button>
        </header>

        <div className="drawer-body">
          <CardEditor
            value={draft}
            onChange={(patch) => {
              setSavedNote(null);
              setDraft((d) => ({ ...d, ...patch }));
            }}
            statuses={statuses}
            disabled={!modifiable}
            statusDisabled={!modifiable && !statusEditable}
            lockable={!creating}
            minDue={creating ? todayLocal() : undefined}
          />

          {!modifiable && !statusEditable && statusCapable && record?.locked && (
            <p className="lock-note" role="status">
              <LockGlyph />
              {LOCKED_REASON}
            </p>
          )}

          {error && <p className="error">{error}</p>}

          {(modifiable || statusEditable) && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="btn btn-primary"
                onClick={() => void save()}
                disabled={busy || !canSave}
              >
                {busy ? "Saving…" : creating ? "Create PO" : "Save changes"}
              </button>
              {modifiable && !creating && record && (
                <button
                  className="btn btn-danger"
                  onClick={remove}
                  disabled={busy || !modifiable}
                >
                  Delete
                </button>
              )}
              {savedNote && (
                <span role="status" style={{ fontSize: "0.75rem", color: "var(--go)" }}>
                  {savedNote}
                </span>
              )}
            </div>
          )}

          {!creating && record && (
            <>
              <TravelerPanel
                poId={record.id}
                jobNo={record.job_no}
                canEditDraft={modifiable}
                onGenerated={() => void loadActivity(record.id)}
              />
              <div className="section-label">Comments</div>
              <CommentThread
                poId={record.id}
                variant="embedded"
                onCountChange={(count) => {
                  setRecord((r) => (r ? { ...r, comment_count: count } : r));
                  onCommentCountChange?.(record.id, count);
                }}
              />
              <div className="section-label">Activity</div>
              <ActivityList items={activity} emptyLabel="No changes recorded yet." />
            </>
          )}
        </div>
      </aside>

      {confirming && (
        <UnsavedChangesPrompt
          creating={creating}
          busy={busy}
          onSave={() => void saveAndClose()}
          onDiscard={onClose}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
