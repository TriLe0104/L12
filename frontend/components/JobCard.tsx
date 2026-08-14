"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { Avatar } from "@/components/Avatar";
import { ImageViewer } from "@/components/ImageViewer";
import { ModelViewer } from "@/components/ModelViewer";
import { api, assetUrl } from "@/lib/api";
import { canEditStatus, useAuth } from "@/lib/auth";
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
import { displayPartIndex, poShowingPart } from "@/lib/parts";
import type { PurchaseOrder } from "@/lib/types";

/** Legacy status → named tone (pre-settings). Mapped to hex via resolveToneColor. */
export const TONE_BY_STATUS: Record<string, string> = {
  need_material_size: "slate",
  order_material: "amber",
  material_incoming: "cyan",
  waiting_setup: "orange",
  running: "blue",
  deburr: "teal",
  inspection: "purple",
  ready_to_plate: "purple",
  ready_to_ship: "green",
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

const isLate = (po: PurchaseOrder, completedStatuses: Set<string>) =>
  po.due_date < new Date().toISOString().slice(0, 10) && !completedStatuses.has(po.status);

/** Full spreadsheet-style job card: the paper card, rebuilt. */
const HIDDEN_AT_DENSITY: Record<"s" | "m" | "l", string[]> = {
  s: ["certificates", "hardware", "inspection", "mat_dim", "finish", "dims"],
  m: ["certificates", "hardware", "inspection"],
  l: [],
};

export function JobCard({
  po,
  onClick,
  onUpdated,
  hideParts = false,
  density = "l",
}: {
  po: PurchaseOrder;
  onClick?: (face?: PurchaseOrder) => void;
  onUpdated?: (saved: PurchaseOrder) => void;
  /** Hide the parts deck chrome (used inside print sheets and the old picker). */
  hideParts?: boolean;
  /** Smaller All Cards sizes drop extra spec rows instead of shrinking type. */
  density?: "s" | "m" | "l";
}) {
  const { user } = useAuth();
  const canShuffle = canEditStatus(user);
  const { document, statusByKey } = useBoardSettings();
  const fields = visibleCardFields(document);
  const customs = customFieldMap(document);
  const completedStatuses = new Set<string>();
  for (const col of document?.kanbanColumns ?? []) {
    if (col.isCompleted) {
      for (const key of col.statusKeys) completedStatuses.add(key);
    }
  }
  // Until settings load, treat Ready to ship as completed so late tint stays quiet.
  if (completedStatuses.size === 0) completedStatuses.add("ready_to_ship");

  // Until settings load, fall back to the classic nine-row grid.
  const rawFields =
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
          { key: "certificates", kind: "builtin" as const, label: "Certificates", visible: true },
          { key: "inspection", kind: "builtin" as const, label: "Inspection", visible: true },
          { key: "hardware", kind: "builtin" as const, label: "Hardware", visible: true },
        ];
  const hideKeys = new Set(HIDDEN_AT_DENSITY[density]);
  const displayFields = rawFields.filter(
    (f) => !hideKeys.has(f.key) && !(density === "s" && f.kind === "custom"),
  );

  const parts = po.parts ?? [];
  const isDeck = !hideParts && parts.length > 1;
  const serverIndex = displayPartIndex(po);
  const [faceIndex, setFaceIndex] = useState(serverIndex);
  const [spread, setSpread] = useState<"stacked" | "deal" | "fold">("stacked");
  const foldTimer = useRef<number | null>(null);
  const [shuffleBusy, setShuffleBusy] = useState(false);
  useEffect(() => {
    setFaceIndex(serverIndex);
  }, [po.id, serverIndex]);
  useEffect(
    () => () => {
      if (foldTimer.current) window.clearTimeout(foldTimer.current);
    },
    [],
  );

  function openDeal() {
    if (foldTimer.current) window.clearTimeout(foldTimer.current);
    setSpread("deal");
  }

  function foldDeal() {
    setSpread("fold");
    if (foldTimer.current) window.clearTimeout(foldTimer.current);
    foldTimer.current = window.setTimeout(() => setSpread("stacked"), 560);
  }

  const shown = hideParts ? po : poShowingPart(po, isDeck ? faceIndex : serverIndex);
  const [viewing, setViewing] = useState(false);
  const [viewingModel, setViewingModel] = useState(false);

  async function chooseFace(next: number, collapse = false) {
    if (!isDeck || shuffleBusy) return;
    setFaceIndex(next);
    if (collapse) foldDeal();
    if (!canShuffle || next === serverIndex) return;
    setShuffleBusy(true);
    try {
      const saved = await api.setDisplayPart(po.id, next);
      onUpdated?.(saved);
    } catch {
      setFaceIndex(faceIndex);
    } finally {
      setShuffleBusy(false);
    }
  }

  function renderFace(
    face: PurchaseOrder,
    opts: { openDrawer?: boolean; current?: boolean } = {},
  ) {
    const facePhoto = assetUrl(face.thumbnail_url);
    const faceTone = statusByKey.get(face.status ?? po.status)?.tone;
    const faceModel = assetUrl(face.model_url);
    const faceFormat = detectModelFormat(face.model_filename ?? face.model_url);
    const faceSize = formatModelSize(face.model_size);
    return (
      <article
        className="jobcard"
        data-locked={po.locked}
        data-current={opts.current ? "true" : undefined}
        data-has-model={!!faceModel}
        style={toneStyle(face.status ?? po.status, faceTone)}
        onClick={() => {
          if (opts.openDrawer) onClick?.(face);
        }}
        role={opts.openDrawer && onClick ? "button" : undefined}
        tabIndex={opts.openDrawer && onClick ? 0 : undefined}
        onKeyDown={(e) => {
          if (opts.openDrawer && onClick && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onClick(face);
          }
        }}
      >
        <header className="jobcard-head">
          <div className="jobcard-job">{po.job_no}</div>
          {po.locked && <LockTag />}
          {faceModel && faceFormat && (
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
              aria-label={`View the 3D model of part ${face.part_number}`}
              title={`3D model: ${face.model_filename ?? MODEL_FORMAT_LABEL[faceFormat]}${
                faceSize ? ` · ${faceSize}` : ""
              }`}
            >
              3D {MODEL_FORMAT_LABEL[faceFormat]}
            </button>
          )}
          {isDeck && (
            <button
              type="button"
              className="jobcard-deck-toggle"
              aria-expanded={spread !== "stacked"}
              title={
                spread !== "stacked"
                  ? "Shuffle parts back into one card"
                  : `Deal all ${parts.length} part cards`
              }
              onClick={(e) => {
                e.stopPropagation();
                if (spread === "deal") foldDeal();
                else openDeal();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {spread !== "stacked" ? "Stack" : `${parts.length} parts`}
            </button>
          )}
          {face.priority !== "normal" && (
            <PriorityTag
              priority={face.priority}
              label={face.priority_label || face.priority.toUpperCase()}
            />
          )}
          <div className="jobcard-due" data-late={isLate(po, completedStatuses)}>
            DUE {formatDue(po.due_date)}
          </div>
        </header>

        <div className="jobcard-body">
          {facePhoto ? (
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
              aria-label={`View photo of part ${face.part_number} full size`}
              title="View photo full size"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={facePhoto} alt={`${face.part_number} part`} />
            </button>
          ) : (
            <div className="jobcard-thumb">NO IMG</div>
          )}

          {viewing && facePhoto && opts.current && (
            <ImageViewer
              src={facePhoto}
              alt={`${face.part_number} part`}
              onClose={() => setViewing(false)}
            />
          )}

          {viewingModel && faceModel && faceFormat && opts.current && (
            <ModelViewer
              src={faceModel}
              filename={face.model_filename ?? `${face.part_number}.${faceFormat}`}
              format={faceFormat}
              onClose={() => setViewingModel(false)}
            />
          )}

          <dl className="spec">
            {displayFields.map((f) => (
              <div key={f.key} className="spec-pair">
                <dt>{f.label}</dt>
                <dd className={f.kind === "builtin" ? builtinClass(f.key, face) : ""}>
                  {f.kind === "builtin" && f.key === "priority" ? (
                    <PriorityTag
                      priority={face.priority}
                      label={face.priority_label || face.priority.toUpperCase()}
                    />
                  ) : f.kind === "builtin" ? (
                    builtinValue(face, f.key)
                  ) : (
                    customValue(face, f.key, customs.get(f.key))
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {face.note && <div className="jobcard-note">{face.note}</div>}

        <footer className="jobcard-status">
          <span>Status:</span>
          <b>{statusByKey.get(face.status ?? po.status)?.label ?? po.status_label}</b>
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

  if (!isDeck) return renderFace(shown, { openDrawer: true, current: true });

  if (spread !== "stacked") {
    return (
      <div className="jobcard-deal" data-count={parts.length} data-phase={spread}>
        {parts.map((_, i) => {
          const face = poShowingPart(po, i);
          const isCurrent = i === faceIndex;
          return (
            <div
              key={i}
              className="jobcard-deal-item"
              data-current={isCurrent}
              data-phase={spread}
              style={
                {
                  ["--deal-i" as string]: i,
                  ["--deal-n" as string]: parts.length,
                } as CSSProperties
              }
              onClick={(e) => {
                e.stopPropagation();
                if (spread === "fold") return;
                if (isCurrent) {
                  onClick?.(face);
                  return;
                }
                void chooseFace(i, true);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {isCurrent && <span className="jobcard-deal-badge">Current</span>}
              {renderFace(face, { current: isCurrent })}
            </div>
          );
        })}
      </div>
    );
  }

  return renderFace(shown, { openDrawer: true, current: true });
}

/** Compact card used inside calendar day cells. */
export function JobChip({ po }: { po: PurchaseOrder }) {
  const { statusByKey } = useBoardSettings();
  const tone = statusByKey.get(po.status)?.tone;
  const parts = po.parts ?? [];
  const shown = poShowingPart(po);
  const photo = assetUrl(shown.thumbnail_url);
  return (
    <div
      className="chip"
      data-locked={po.locked}
      style={toneStyle(po.status, tone)}
      title={`${po.job_no} · ${po.po_number}${po.locked ? " · locked" : ""}`}
    >
      <div className="chip-top">
        {photo ? (
          <div className="chip-thumb">
            <img src={photo} alt="" />
            {parts.length > 1 && <span className="chip-parts-count">{parts.length}</span>}
          </div>
        ) : (
          parts.length > 1 && <span className="chip-parts-inline">{parts.length}</span>
        )}
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
        <span className="chip-qty">×{shown.qty}</span>
      </div>
      <div className="chip-mat">{shown.material ?? "material TBD"}</div>
      <div className="chip-status">{po.status_label}</div>
    </div>
  );
}
