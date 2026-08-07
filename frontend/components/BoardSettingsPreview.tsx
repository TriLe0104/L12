"use client";

import { memo, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { CardEditor } from "@/components/CardEditor";
import { BoardSettingsScope, useBoardSettings } from "@/lib/boardSettings";
import type { BoardDocument } from "@/lib/boardTypes";
import {
  dashboardColumnWidthStyle,
  PREVIEW_SAMPLE,
  resolveToneColor,
  selectionOptions,
} from "@/lib/boardTypes";
import { captureRects, playFlip, rectSignature, type RectMap } from "@/lib/flip";
import type { PODraft } from "@/lib/types";

/** Field rows are the one part of the preview card worth animating; the ids
 *  live on the editor's own cells so no second card has to exist. */
const CARD_FLIP_PREFIX = "preview-field-";

function usePreviewFlip<T extends HTMLElement>(external?: RefObject<T | null>) {
  const ownRef = useRef<T | null>(null);
  const rootRef = external ?? ownRef;
  const previousRects = useRef<RectMap>(new Map());
  const previousSignature = useRef<string | null>(null);
  useLayoutEffect(() => {
    // One measuring pass feeds both the signature and the next frame's "before".
    const rects = captureRects(rootRef.current);
    const signature = rectSignature(rects);
    // Editing a label reflows the preview without changing which nodes are
    // there, and sliding every neighbour 260ms per keystroke is the flicker.
    // Only reorders, adds and removes earn an animation.
    if (previousSignature.current !== null && signature !== previousSignature.current) {
      playFlip(rootRef.current, previousRects.current, { duration: 260 });
    }
    previousSignature.current = signature;
    previousRects.current = rects;
  });
  return rootRef;
}

/** The preview pane is narrower than the drawer, and a narrower card is a
 *  different card: every container query inside it would answer at another size
 *  step, so labels would wrap where the real card's do not. The card is laid
 *  out at the drawer's own width and the whole stage is scaled to fit instead. */
function useCardStageFit() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const inner = innerRef.current;
    if (!stage || !inner) return;

    let lastScale = "";
    let lastHeight = "";
    const fit = () => {
      const available = stage.clientWidth;
      // offsetWidth/Height are the pre-transform box, which is what we scale
      const natural = inner.offsetWidth;
      if (!available || !natural) return;
      const scale = Math.min(1, available / natural);
      const nextScale = String(Math.round(scale * 10000) / 10000);
      // The stage no longer inherits the card's height once it is scaled, and
      // writing an unchanged value would keep the observer firing forever.
      const nextHeight = `${Math.ceil(inner.offsetHeight * scale)}px`;
      if (nextScale !== lastScale) {
        stage.style.setProperty("--card-stage-scale", nextScale);
        lastScale = nextScale;
      }
      if (nextHeight !== lastHeight) {
        stage.style.height = nextHeight;
        lastHeight = nextHeight;
      }
    };

    fit();
    // The pane supplies the width, the card its own height — hiding a field
    // shortens it, and the stage has to follow.
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  return { stageRef, innerRef };
}

/** The real card editor, read-only, reading the draft document through the
 *  scope around it — including the status catalog its footer offers. */
function PreviewCard({ sample }: { sample: PODraft }) {
  const { statuses } = useBoardSettings();
  return (
    <CardEditor
      value={sample}
      onChange={() => {}}
      statuses={statuses}
      disabled
      lockable
      flipPrefix={CARD_FLIP_PREFIX}
    />
  );
}

/** Live preview of card + dashboard headers + kanban, driven by the draft document. */
function BoardSettingsPreviewImpl({ document }: { document: BoardDocument }) {
  const { stageRef, innerRef } = useCardStageFit();
  usePreviewFlip(innerRef);
  const statusesRef = usePreviewFlip<HTMLDivElement>();
  const dashboardRef = usePreviewFlip<HTMLDivElement>();
  const dashboardFiltersRef = usePreviewFlip<HTMLDivElement>();
  const kanbanRef = usePreviewFlip<HTMLDivElement>();
  const dashCols = document.dashboardColumns.filter((c) => c.visible);
  const filterCols = document.dashboardColumns.filter((c) => c.filterable);
  const sampleStatus =
    document.statuses.find((s) => s.key === PREVIEW_SAMPLE.status) ?? document.statuses[0];
  const statusKey = sampleStatus?.key ?? "need_material_size";
  const statusLabel = sampleStatus?.label ?? "Need Material Size";

  const sample = {
    ...PREVIEW_SAMPLE,
    status: statusKey,
    status_label: statusLabel,
    // The owner picker reads an id; without one the sample card would show an
    // empty select where the real card shows a name.
    owner_id: PREVIEW_SAMPLE.owner.id,
    custom_fields: Object.fromEntries(
      document.customFields.map((f) => [
        f.key,
        f.type === "number"
          ? 12
          : f.type === "date"
            ? "2026-08-15"
            : f.type === "select"
              ? (selectionOptions(document, f.key)[0] ?? "—")
              : "Sample",
      ]),
    ),
  } as PODraft;

  return (
    <aside className="settings-preview" aria-label="Live preview">
      <header className="settings-preview-head">
        <h2>Preview</h2>
        <p>Sample data — saving does not change real orders.</p>
      </header>

      <section className="settings-preview-block">
        <h3>Card</h3>
        {/* Not a lookalike — the drawer's own card editor, drawn against the
            draft and made inert. Whatever the card gains, the preview gains. */}
        <div ref={stageRef} className="card-stage">
          <div ref={innerRef} className="card-stage-inner" inert>
            <BoardSettingsScope document={document}>
              <PreviewCard sample={sample} />
            </BoardSettingsScope>
          </div>
        </div>
        <div ref={statusesRef} className="settings-preview-chips" aria-label="Status chips">
          {document.statuses.map((s) => (
            <span
              key={s.key}
              data-flip-id={`preview-status:${s.key}`}
              className="settings-status-chip"
              style={{ ["--tone" as string]: resolveToneColor(s.tone) }}
            >
              {s.label}
            </span>
          ))}
        </div>
      </section>

      <section className="settings-preview-block">
        <h3>Dashboard columns</h3>
        {filterCols.length > 0 && (
          <div
            ref={dashboardFiltersRef}
            className="settings-preview-filters"
            aria-label="Dashboard filters"
          >
            {filterCols.map((c) => (
              <span
                key={c.key}
                data-flip-id={`preview-dash-filter:${c.key}`}
                className="settings-preview-filter-pill"
              >
                {c.label}
              </span>
            ))}
          </div>
        )}
        <div ref={dashboardRef} className="settings-preview-dash">
          {dashCols.map((c) => {
            const widthStyle = dashboardColumnWidthStyle(c.widthRem);
            return (
              <span
                key={c.key}
                data-flip-id={`preview-dashboard:${c.key}`}
                style={
                  widthStyle
                    ? {
                        flex: `0 0 ${widthStyle.width}`,
                        width: widthStyle.width,
                        maxWidth: widthStyle.width,
                      }
                    : { flex: "1 1 6rem", minWidth: "4rem" }
                }
                title={
                  c.widthRem != null ? `${c.label} · ${c.widthRem}rem` : `${c.label} · auto`
                }
              >
                {c.label}
              </span>
            );
          })}
        </div>
      </section>

      <section className="settings-preview-block">
        <h3>Task progress</h3>
        <div
          ref={kanbanRef}
          className="settings-preview-kanban"
          style={{ ["--cols" as string]: String(Math.max(document.kanbanColumns.length, 1)) }}
        >
          {document.kanbanColumns.map((col) => (
            <div
              key={col.key}
              className="settings-preview-kcol"
              data-flip-id={`preview-kanban:${col.key}`}
            >
              <header style={{ ["--tone" as string]: resolveToneColor(col.tone) }}>
                <b>{col.label}</b>
                {col.isCompleted && <small>completed</small>}
              </header>
              <ul>
                {col.statusKeys.map((sk) => {
                  const st = document.statuses.find((s) => s.key === sk);
                  return <li key={sk}>{st?.label ?? sk}</li>;
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

/** The settings page re-renders on every keystroke; the preview only needs to
 *  when the document it is drawing actually changes. Without this, each key
 *  press costs a full remeasure of every preview node. */
export const BoardSettingsPreview = memo(BoardSettingsPreviewImpl);
