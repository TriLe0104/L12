"use client";

import { useState, type CSSProperties } from "react";

import { Avatar } from "@/components/Avatar";
import { ImageViewer } from "@/components/ImageViewer";
import { ModelViewer } from "@/components/ModelViewer";
import { assetUrl } from "@/lib/api";
import { useBoardSettings } from "@/lib/boardSettings";
import {
  builtinClass,
  builtinValue,
  customFieldMap,
  customValue,
  visibleCardFields,
} from "@/lib/cardFields";
import {
  detectModelFormat,
  formatModelSize,
  MODEL_FORMAT_LABEL,
} from "@/lib/model-format";
import { resolveToneColor } from "@/lib/boardTypes";
import type { PurchaseOrder } from "@/lib/types";

/** Legacy status → named tone (pre-settings). Mapped to hex via resolveToneColor. */
export const TONE_BY_STATUS: Record<string, string> = {
  new: "slate",
  rfq_finishing: "cyan",
  in_machining: "blue",
  finishing: "teal",
  under_inspection: "amber",
  wait_vqc: "red",
  ready_to_ship: "green",
  shipped: "graphite",
  on_hold: "orange",
};

export const toneStyle = (status: string, tone?: string): CSSProperties =>
  ({
    "--tone": resolveToneColor(tone ?? TONE_BY_STATUS[status]),
  }) as CSSProperties;

export const TONE_BY_PRIORITY: Record<string, string> = {
  hot: "red",
  high: "orange",
  normal: "slate",
  low: "graphite",
};

export function PriorityTag({ priority, label }: { priority: string; label: string }) {
  return (
    <span
      className="prio"
      data-priority={priority}
      style={{ ["--prio" as string]: `var(--tone-${TONE_BY_PRIORITY[priority] ?? "slate"})` }}
      title={`Priority: ${label}`}
    >
      {label}
    </span>
  );
}

export function LockGlyph() {
  return (
    <svg className="lock-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M3.6 5.2V3.7a2.4 2.4 0 0 1 4.8 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="5.2" width="7" height="5.1" rx="1.1" fill="currentColor" />
    </svg>
  );
}

/** Quiet badge marking a frozen order — same idiom as the priority tag. */
export function LockTag() {
  return (
    <span className="lock-tag" title="Locked — only an admin can change it">
      <LockGlyph />
      LOCKED
    </span>
  );
}

export function formatDue(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${String(y).slice(2)}`;
}

const isLate = (po: PurchaseOrder) =>
  po.due_date < new Date().toISOString().slice(0, 10) &&
  !["shipped", "ready_to_ship"].includes(po.status);

/** Full spreadsheet-style job card: the paper card, rebuilt. */
export function JobCard({ po, onClick }: { po: PurchaseOrder; onClick?: () => void }) {
  const { document, statusByKey } = useBoardSettings();
  const fields = visibleCardFields(document);
  const customs = customFieldMap(document);
  const tone = statusByKey.get(po.status)?.tone;

  // Until settings load, fall back to the classic nine-row grid.
  const displayFields =
    fields.length > 0
      ? fields
      : [
          { key: "po_number", kind: "builtin" as const, label: "PO #", visible: true },
          { key: "part_number", kind: "builtin" as const, label: "Part #", visible: true },
          { key: "qty", kind: "builtin" as const, label: "Qty", visible: true },
          { key: "dims", kind: "builtin" as const, label: "Dims", visible: true },
          { key: "mat_dim", kind: "builtin" as const, label: "Mat Dim", visible: true },
          { key: "material", kind: "builtin" as const, label: "Material", visible: true },
          { key: "finish", kind: "builtin" as const, label: "Finish", visible: true },
          { key: "inspection", kind: "builtin" as const, label: "Inspection", visible: true },
          { key: "hardware", kind: "builtin" as const, label: "Hardware", visible: true },
        ];

  const photo = assetUrl(po.thumbnail_url);
  const [viewing, setViewing] = useState(false);

  const model = assetUrl(po.model_url);
  const modelFormat = detectModelFormat(po.model_filename ?? po.model_url);
  const modelSize = formatModelSize(po.model_size);
  const [viewingModel, setViewingModel] = useState(false);

  return (
    <article
      className="jobcard"
      data-locked={po.locked}
      data-has-model={!!model}
      style={toneStyle(po.status, tone)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <header className="jobcard-head">
        <div className="jobcard-job">{po.job_no}</div>
        {po.locked && <LockTag />}
        {/* A badge in the same family as LOCKED and the priority tag, but a real
            button: at a glance the order has a model, and one click opens it.
            The click is stopped here or the card would open the drawer too. */}
        {model && modelFormat && (
          <button
            type="button"
            className="model-tag model-tag-button"
            onClick={(e) => {
              e.stopPropagation();
              setViewingModel(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") e.stopPropagation();
            }}
            aria-label={`View the 3D model of part ${po.part_number}`}
            title={`3D model: ${po.model_filename ?? MODEL_FORMAT_LABEL[modelFormat]}${
              modelSize ? ` · ${modelSize}` : ""
            }`}
          >
            3D {MODEL_FORMAT_LABEL[modelFormat]}
          </button>
        )}
        {po.priority !== "normal" && (
          <PriorityTag priority={po.priority} label={po.priority_label} />
        )}
        <div className="jobcard-due" data-late={isLate(po)}>
          DUE {formatDue(po.due_date)}
        </div>
      </header>

      <div className="jobcard-body">
        {photo ? (
          /* A real button, so the photo is tabbable; both the click and the
             Enter/Space that produced it are stopped here, otherwise the card
             around it would open the detail drawer as well. */
          <button
            type="button"
            className="jobcard-thumb"
            onClick={(e) => {
              e.stopPropagation();
              setViewing(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") e.stopPropagation();
            }}
            aria-label={`View photo of part ${po.part_number} full size`}
            title="View photo full size"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo} alt={`${po.part_number} part`} />
          </button>
        ) : (
          <div className="jobcard-thumb">NO IMG</div>
        )}

        {viewing && photo && (
          <ImageViewer
            src={photo}
            alt={`${po.part_number} part`}
            onClose={() => setViewing(false)}
          />
        )}

        {viewingModel && model && modelFormat && (
          <ModelViewer
            src={model}
            filename={po.model_filename ?? `${po.part_number}.${modelFormat}`}
            format={modelFormat}
            onClose={() => setViewingModel(false)}
          />
        )}

        <dl className="spec">
          {displayFields.map((f) => (
            <div key={f.key} className="spec-pair">
              <dt>{f.label}</dt>
              <dd className={f.kind === "builtin" ? builtinClass(f.key, po) : ""}>
                {f.kind === "builtin"
                  ? builtinValue(po, f.key)
                  : customValue(po, f.key, customs.get(f.key))}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {po.note && <div className="jobcard-note">{po.note}</div>}

      <footer className="jobcard-status">
        <span>Status:</span>
        <b>{po.status_label}</b>
        {po.owner && (
          <Avatar
            initials={po.owner.initials}
            avatarUrl={po.owner.avatar_url}
            title={po.owner.name}
          />
        )}
      </footer>
    </article>
  );
}

/** Compact card used inside calendar day cells. */
export function JobChip({ po }: { po: PurchaseOrder }) {
  const { statusByKey } = useBoardSettings();
  const tone = statusByKey.get(po.status)?.tone;
  return (
    <div
      className="chip"
      data-locked={po.locked}
      style={toneStyle(po.status, tone)}
      title={`${po.job_no} · ${po.po_number}${po.locked ? " · locked" : ""}`}
    >
      <div className="chip-top">
        <span className="chip-job">{po.job_no}</span>
        {po.locked && (
          <span className="chip-lock" title="Locked">
            <LockGlyph />
          </span>
        )}
        {po.priority !== "normal" && (
          <span
            className="chip-prio"
            style={{ ["--prio" as string]: `var(--tone-${TONE_BY_PRIORITY[po.priority]})` }}
            title={`Priority: ${po.priority_label}`}
          />
        )}
        <span className="chip-po">{po.po_number}</span>
        <span className="chip-qty">×{po.qty}</span>
      </div>
      <div className="chip-mat">{po.material ?? "material TBD"}</div>
      <div className="chip-status">{po.status_label}</div>
    </div>
  );
}
