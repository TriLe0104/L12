"use client";

import { useState, type CSSProperties } from "react";

import { Avatar } from "@/components/Avatar";
import { ImageViewer } from "@/components/ImageViewer";
import { ModelViewer } from "@/components/ModelViewer";
import { assetUrl } from "@/lib/api";
import {
  detectModelFormat,
  formatModelSize,
  MODEL_FORMAT_LABEL,
} from "@/lib/model-format";
import type { PurchaseOrder } from "@/lib/types";

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

export const toneStyle = (status: string): CSSProperties =>
  ({ "--tone": `var(--tone-${TONE_BY_STATUS[status] ?? "slate"})` }) as CSSProperties;

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
      style={toneStyle(po.status)}
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
          <dt>PO #</dt>
          <dd className="mono">{po.po_number}</dd>
          <dt>Part #</dt>
          <dd className="mono">{po.part_number}</dd>
          <dt>Qty</dt>
          <dd className="mono">{po.qty}</dd>
          <dt>Dims</dt>
          <dd className="mono">{po.dims ?? "—"}</dd>
          <dt>Mat Dim</dt>
          <dd className="mono warn">{po.mat_dim ?? "—"}</dd>
          <dt>Material</dt>
          <dd>{po.material ?? "—"}</dd>
          <dt>Finish</dt>
          <dd className="go">{po.finish ?? "—"}</dd>
          <dt>Inspection</dt>
          <dd>{po.inspection.toUpperCase()}</dd>
          <dt>Hardware</dt>
          <dd className={po.hardware ? "go" : "warn"}>{po.hardware ? "YES" : "NO"}</dd>
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
  return (
    <div
      className="chip"
      data-locked={po.locked}
      style={toneStyle(po.status)}
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
