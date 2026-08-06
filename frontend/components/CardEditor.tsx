"use client";

import { useEffect, useRef, useState } from "react";

import { api, assetUrl } from "@/lib/api";
import { useBoardSettings } from "@/lib/boardSettings";
import {
  customFieldMap,
  patchCustomField,
  visibleCardFields,
} from "@/lib/cardFields";
import {
  PRIORITY_ORDER,
  ROLE_LABEL,
  type Assignee,
  type PODraft,
  type PurchaseOrder,
  type StatusMeta,
} from "@/lib/types";
import {
  detectModelFormat,
  formatModelSize,
  MODEL_ACCEPT,
  MODEL_FORMAT_LABEL,
} from "@/lib/model-format";
import { Avatar } from "./Avatar";
import { ImageViewer } from "./ImageViewer";
import { ModelViewer } from "./ModelViewer";
import { LockGlyph, TONE_BY_PRIORITY, toneStyle } from "./JobCard";

const INSPECTIONS = ["formal", "standard", "source", "none"] as const;

const FALLBACK_EDITOR_FIELDS = [
  { key: "po_number", kind: "builtin" as const, label: "PO #", visible: true },
  { key: "part_number", kind: "builtin" as const, label: "Part #", visible: true },
  { key: "qty", kind: "builtin" as const, label: "Qty", visible: true },
  { key: "dims", kind: "builtin" as const, label: "Dims", visible: true },
  { key: "mat_dim", kind: "builtin" as const, label: "Mat Dim", visible: true },
  { key: "material", kind: "builtin" as const, label: "Material", visible: true },
  { key: "finish", kind: "builtin" as const, label: "Finish", visible: true },
  { key: "inspection", kind: "builtin" as const, label: "Inspection", visible: true },
  { key: "hardware", kind: "builtin" as const, label: "Hardware", visible: true },
  { key: "priority", kind: "builtin" as const, label: "Priority", visible: true },
  { key: "customer", kind: "builtin" as const, label: "Customer", visible: true },
  { key: "owner", kind: "builtin" as const, label: "Owner", visible: true },
];

/** The paper card, made editable: same grid as JobCard, every value cell an input. */
export function CardEditor({
  value,
  onChange,
  statuses,
  disabled = false,
  statusDisabled,
  lockable = false,
  minDue,
}: {
  value: PODraft;
  onChange: (patch: PODraft) => void;
  statuses: StatusMeta[];
  disabled?: boolean;
  /** When set, gates only the status select — so a User can move status while
   *  every other field stays read-only. Defaults to `disabled`. */
  statusDisabled?: boolean;
  /** show the lock toggle — off while creating, since a PO is born unlocked */
  lockable?: boolean;
  /** `YYYY-MM-DD` floor for the due date; left off when editing an existing PO
   *  so overdue jobs stay editable. */
  minDue?: string;
}) {
  const statusLocked = statusDisabled ?? disabled;
  const { document, statusByKey } = useBoardSettings();
  const configured = visibleCardFields(document);
  const fields = configured.length > 0 ? configured : FALLBACK_EDITOR_FIELDS;
  const customs = customFieldMap(document);
  const statusTone = statusByKey.get(value.status ?? "new")?.tone;

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [people, setPeople] = useState<Assignee[]>([]);

  const modelRef = useRef<HTMLInputElement>(null);
  const [modelUploading, setModelUploading] = useState(false);
  const [modelDragOver, setModelDragOver] = useState(false);
  const [viewingModel, setViewingModel] = useState(false);

  const thumb = assetUrl(value.thumbnail_url);
  const modelSrc = assetUrl(value.model_url);
  const modelName = value.model_filename ?? "";
  const modelFormat = detectModelFormat(modelName || value.model_url);
  const modelSize = formatModelSize(value.model_size);

  // Only an editable card needs the roster; a read-only one already knows the
  // one name it has to show, and asking would earn a 403.
  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    api
      .assignableUsers()
      .then((list) => !cancelled && setPeople(list))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [disabled]);

  // The saved record carries its owner expanded, the draft carries an id once the
  // picker is touched — and `null` is a real answer there, so the draft only wins
  // when the field exists at all.
  const ownerId = value.owner_id !== undefined ? value.owner_id : (value.owner?.id ?? null);
  const listed = people.find((p) => p.id === ownerId) ?? null;
  // Someone who has left the roster still owns the orders they were given: keep
  // them selectable so the picker reads as a name rather than as a blank.
  const stray = !listed && ownerId && value.owner?.id === ownerId ? value.owner : null;
  const owner = listed ?? stray;

  async function upload(file: File | undefined) {
    if (!file || disabled) return;
    setUploading(true);
    setUploadError(null);
    try {
      const res = await api.uploadImage(file);
      onChange({ thumbnail_url: res.url });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  /* One model per order: a second upload replaces the first, exactly as the
     photo well above does. The server re-checks the file's leading bytes, so a
     rejection here carries a real reason rather than a generic failure. */
  async function uploadModel(file: File | undefined) {
    if (!file || disabled) return;
    setModelUploading(true);
    setUploadError(null);
    try {
      const res = await api.uploadModel(file);
      onChange({ model_url: res.url, model_filename: res.filename, model_size: res.size });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Model upload failed");
    } finally {
      setModelUploading(false);
    }
  }

  return (
    <article className="jobcard jobcard-edit" style={toneStyle(value.status ?? "new", statusTone)}>
      <header className="jobcard-head">
        <input
          className="cell-input job-input"
          placeholder="J-00"
          aria-label="Job number"
          value={value.job_no ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ job_no: e.target.value })}
        />
        {lockable && (
          <button
            type="button"
            className="lock-toggle"
            data-locked={!!value.locked}
            aria-pressed={!!value.locked}
            disabled={disabled}
            onClick={() => onChange({ locked: !value.locked })}
            title={
              value.locked
                ? "Locked — only an admin can change this order. Unlock, then save."
                : "Lock this order so only an admin can change it. Save to apply."
            }
          >
            <LockGlyph />
            {value.locked ? "LOCKED" : "LOCK"}
          </button>
        )}
        <label className="due-edit">
          DUE
          <input
            className="cell-input"
            type="date"
            aria-label="Due date"
            value={value.due_date ?? ""}
            min={minDue}
            disabled={disabled}
            onChange={(e) => onChange({ due_date: e.target.value })}
          />
        </label>
      </header>

      <div className="jobcard-body">
        {/* Photo and model stack in one column so the model slot sits beside the
            spec grid rather than stealing a second column from it. */}
        <div className="card-wells">
          <div
            className="thumb-drop"
            data-dragover={dragOver}
            onClick={() => !disabled && fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void upload(e.dataTransfer.files[0]);
            }}
            role="button"
            tabIndex={disabled ? -1 : 0}
            onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
            title={
              thumb
                ? "Click or drop an image to replace it — use ⤢ to view it full size"
                : "Click or drop an image of the part"
            }
          >
            {thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumb} alt="Part" />
            ) : (
              <span>{uploading ? "UPLOADING…" : "+ IMAGE"}</span>
            )}
            {/* The well itself stays the upload control, so viewing gets its own
                affordance in the opposite corner from the remove button. */}
            {thumb && (
              <button
                type="button"
                className="thumb-expand"
                onClick={(e) => {
                  e.stopPropagation();
                  setViewing(true);
                }}
                aria-label="View photo full size"
                title="View photo full size"
              >
                ⤢
              </button>
            )}
            {thumb && !disabled && (
              <button
                type="button"
                className="thumb-clear"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange({ thumbnail_url: null });
                }}
                aria-label="Remove image"
              >
                ×
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => void upload(e.target.files?.[0])}
            />
          </div>

          {/* Same idiom as the photo well: the well is the upload control, with
              view and remove as corner affordances in opposite corners. */}
          <div
            className="model-drop"
            data-dragover={modelDragOver}
            data-filled={!!modelSrc}
            onClick={() => !disabled && modelRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setModelDragOver(true);
            }}
            onDragLeave={() => setModelDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setModelDragOver(false);
              void uploadModel(e.dataTransfer.files[0]);
            }}
            role="button"
            tabIndex={disabled ? -1 : 0}
            onKeyDown={(e) => e.key === "Enter" && !disabled && modelRef.current?.click()}
            title={
              modelSrc
                ? `${modelName} — click or drop to replace it, ⤢ to open the 3D viewer`
                : "Click or drop a 3D model (OBJ, FBX, STEP, 3DM)"
            }
          >
            {modelUploading ? (
              <span className="model-drop-label">UPLOADING…</span>
            ) : modelSrc && modelFormat ? (
              <>
                <span className="model-tag">{MODEL_FORMAT_LABEL[modelFormat]}</span>
                <span className="model-drop-name">{modelName || "model"}</span>
                {modelSize && <span className="model-drop-size mono">{modelSize}</span>}
              </>
            ) : (
              <span className="model-drop-label">+ 3D MODEL</span>
            )}

            {modelSrc && modelFormat && (
              <button
                type="button"
                className="thumb-expand model-expand"
                onClick={(e) => {
                  e.stopPropagation();
                  setViewingModel(true);
                }}
                aria-label="View 3D model"
                title="View 3D model"
              >
                ⤢
              </button>
            )}
            {modelSrc && !disabled && (
              <button
                type="button"
                className="thumb-clear model-clear"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange({ model_url: null, model_filename: null, model_size: null });
                }}
                aria-label="Remove 3D model"
              >
                ×
              </button>
            )}
            <input
              ref={modelRef}
              type="file"
              accept={MODEL_ACCEPT}
              hidden
              onChange={(e) => void uploadModel(e.target.files?.[0])}
            />
          </div>
        </div>

        {viewing && thumb && (
          <ImageViewer src={thumb} alt="Part photo" onClose={() => setViewing(false)} />
        )}

        {viewingModel && modelSrc && modelFormat && (
          <ModelViewer
            src={modelSrc}
            filename={modelName || "model"}
            format={modelFormat}
            onClose={() => setViewingModel(false)}
          />
        )}

        <dl className="spec">
          {fields.map((f) => (
            <div key={f.key} className="spec-pair">
              <dt>{f.label}</dt>
              <dd>
                {f.kind === "custom" ? (
                  (() => {
                    const meta = customs.get(f.key);
                    const raw = value.custom_fields?.[f.key];
                    const str = raw == null ? "" : String(raw);
                    if (meta?.type === "select") {
                      return (
                        <select
                          className="cell-input"
                          value={str}
                          disabled={disabled}
                          onChange={(e) =>
                            onChange({
                              custom_fields: patchCustomField(value, f.key, e.target.value || null),
                            })
                          }
                        >
                          <option value="">—</option>
                          {(meta.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      );
                    }
                    return (
                      <input
                        className="cell-input"
                        type={meta?.type === "number" ? "number" : meta?.type === "date" ? "date" : "text"}
                        value={str}
                        disabled={disabled}
                        onChange={(e) => {
                          const v =
                            meta?.type === "number"
                              ? e.target.value === ""
                                ? null
                                : Number(e.target.value)
                              : e.target.value || null;
                          onChange({ custom_fields: patchCustomField(value, f.key, v) });
                        }}
                      />
                    );
                  })()
                ) : f.key === "po_number" ? (
                  <input
                    className="cell-input mono"
                    value={value.po_number ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChange({ po_number: e.target.value })}
                  />
                ) : f.key === "part_number" ? (
                  <input
                    className="cell-input mono"
                    value={value.part_number ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChange({ part_number: e.target.value })}
                  />
                ) : f.key === "qty" ? (
                  <input
                    className="cell-input mono"
                    type="number"
                    min={1}
                    value={value.qty ?? 1}
                    disabled={disabled}
                    onChange={(e) => onChange({ qty: Number(e.target.value) })}
                  />
                ) : f.key === "dims" ? (
                  <input
                    className="cell-input mono"
                    placeholder="0.905 x 0.870 x 0.345in"
                    value={value.dims ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChange({ dims: e.target.value })}
                  />
                ) : f.key === "mat_dim" ? (
                  <input
                    className="cell-input mono warn"
                    placeholder="1.25 x 1.7 x .500"
                    value={value.mat_dim ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChange({ mat_dim: e.target.value })}
                  />
                ) : f.key === "material" ? (
                  <input
                    className="cell-input"
                    placeholder="AL 6061-T651, Plate"
                    value={value.material ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChange({ material: e.target.value })}
                  />
                ) : f.key === "finish" ? (
                  <input
                    className="cell-input go"
                    placeholder="CLEAR ANODIZE; CHEM FILM GOLD"
                    value={value.finish ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChange({ finish: e.target.value })}
                  />
                ) : f.key === "inspection" ? (
                  <select
                    className="cell-input"
                    value={value.inspection ?? "standard"}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange({ inspection: e.target.value as PurchaseOrder["inspection"] })
                    }
                  >
                    {INSPECTIONS.map((i) => (
                      <option key={i} value={i}>
                        {i.toUpperCase()}
                      </option>
                    ))}
                  </select>
                ) : f.key === "hardware" ? (
                  <select
                    className={`cell-input ${value.hardware ? "go" : "warn"}`}
                    value={value.hardware ? "yes" : "no"}
                    disabled={disabled}
                    onChange={(e) => onChange({ hardware: e.target.value === "yes" })}
                  >
                    <option value="no">NO</option>
                    <option value="yes">YES</option>
                  </select>
                ) : f.key === "priority" ? (
                  <select
                    className="cell-input"
                    value={value.priority ?? "normal"}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange({ priority: e.target.value as PurchaseOrder["priority"] })
                    }
                    style={{
                      color: `var(--tone-${TONE_BY_PRIORITY[value.priority ?? "normal"]})`,
                      fontWeight: 700,
                    }}
                  >
                    {PRIORITY_ORDER.map((p) => (
                      <option key={p} value={p}>
                        {p.toUpperCase()}
                      </option>
                    ))}
                  </select>
                ) : f.key === "customer" ? (
                  <input
                    className="cell-input"
                    placeholder="Program or customer"
                    value={value.customer ?? ""}
                    disabled={disabled}
                    onChange={(e) => onChange({ customer: e.target.value })}
                  />
                ) : f.key === "owner" ? (
                  <div
                    className="owner-pick"
                    title={
                      owner
                        ? `Owner: ${owner.name}${listed ? ` · ${ROLE_LABEL[listed.role]}` : ""}`
                        : "Nobody owns this order yet"
                    }
                  >
                    <Avatar
                      size="sm"
                      initials={owner?.initials ?? "—"}
                      avatarUrl={owner?.avatar_url}
                      title={owner?.name ?? "Unassigned"}
                    />
                    <select
                      className="cell-input"
                      aria-label="Owner"
                      value={ownerId ?? ""}
                      disabled={disabled}
                      onChange={(e) => onChange({ owner_id: e.target.value || null })}
                    >
                      <option value="">Unassigned</option>
                      {stray && <option value={stray.id}>{stray.name}</option>}
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {uploadError && <div className="jobcard-note error">{uploadError}</div>}

      <div className="jobcard-note">
        <input
          className="cell-input"
          placeholder="Note — e.g. no dim change, just censoring"
          value={value.note ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ note: e.target.value })}
        />
      </div>

      <footer className="jobcard-status">
        <span>Status:</span>
        <select
          className="cell-input status-input"
          value={value.status ?? "new"}
          disabled={statusLocked}
          onChange={(e) => onChange({ status: e.target.value as PurchaseOrder["status"] })}
        >
          {statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </footer>
    </article>
  );
}
