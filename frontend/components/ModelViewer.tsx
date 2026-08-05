"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { MODEL_FORMAT_LABEL, type ModelFormat } from "@/lib/model-format";
import type { LoadProgress } from "@/lib/model-loaders";
import type { ModelStats } from "./ModelCanvas";

/** The full-screen 3D viewer: the same scrim, portal, Escape handling, scroll
 *  lock and focus return as ImageViewer, with an interactive canvas where the
 *  photo would be. The two are meant to read as one feature.
 *
 *  Only the chrome is in this file. three.js and the CAD translators sit behind
 *  the dynamic import below, so clicking the control paints the frame and its
 *  loading state immediately and the 3D machinery arrives after. */
const ModelCanvas = dynamic(() => import("./ModelCanvas").then((m) => m.ModelCanvas), {
  ssr: false,
  loading: () => <div className="model-canvas" />,
});

const PHASE_LABEL: Record<LoadProgress["phase"], string> = {
  downloading: "Downloading",
  translating: "Translating",
  building: "Building scene",
};

/** Three significant figures is plenty for "how big is this thing". */
const dim = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(3));

export function ModelViewer({
  src,
  filename,
  format,
  onClose,
}: {
  src: string;
  filename: string;
  format: ModelFormat;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [progress, setProgress] = useState<LoadProgress>({ phase: "downloading" });
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  /* The viewport scroller is <html> here (both it and <body> are height:100%),
     so that is what has to be pinned. Its scrollbar is padded back in, or the
     page underneath would jump sideways as the viewer opens. */
  useEffect(() => {
    const root = document.documentElement;
    const gap = window.innerWidth - root.clientWidth;
    const previous = { overflow: root.style.overflow, padding: root.style.paddingRight };
    root.style.overflow = "hidden";
    if (gap > 0) root.style.paddingRight = `${gap}px`;
    return () => {
      root.style.overflow = previous.overflow;
      root.style.paddingRight = previous.padding;
    };
  }, []);

  /* Focus lands on the close button and returns to the trigger afterwards, so a
     keyboard user is never dropped back at the top of the page. */
  useEffect(() => {
    if (!mounted) return;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, [mounted]);

  /* Capture phase: the drawer closes on Escape from a window listener of its
     own, and only the viewer should react while the viewer is up. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /* Stable identities: ModelCanvas owns a WebGL context keyed on these, and a
     fresh callback each render would tear it down and rebuild it. */
  const handleProgress = useCallback((p: LoadProgress) => setProgress(p), []);
  const handleLoaded = useCallback((s: ModelStats) => {
    setStats(s);
    setError(null);
  }, []);
  const handleError = useCallback((message: string) => setError(message), []);

  if (!mounted) return null;

  const state = error ? "error" : stats ? "ready" : "loading";
  const percent =
    progress.ratio !== undefined ? ` ${Math.round(progress.ratio * 100)}%` : "…";

  return createPortal(
    <div
      className="scrim model-viewer"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="model-viewer-frame"
        role="dialog"
        aria-modal="true"
        aria-label={`3D model ${filename}`}
        data-model-state={state}
        data-model-format={format}
        data-triangles={stats?.triangles ?? ""}
        data-vertices={stats?.vertices ?? ""}
        data-bbox={stats ? stats.size.join(",") : ""}
        data-elapsed-ms={stats?.elapsedMs ?? ""}
      >
        <header className="model-viewer-head">
          <span className="model-tag">{MODEL_FORMAT_LABEL[format]}</span>
          <span className="model-viewer-name" title={filename}>
            {filename}
          </span>
        </header>

        <div className="model-viewer-stage">
          <ModelCanvas
            url={src}
            format={format}
            resetSignal={resetSignal}
            onProgress={handleProgress}
            onLoaded={handleLoaded}
            onError={handleError}
          />

          {state === "loading" && (
            <div className="model-viewer-overlay" role="status">
              <span className="model-spinner" aria-hidden="true" />
              <span>
                {PHASE_LABEL[progress.phase]}
                {percent}
              </span>
              {format === "step" && (
                <small>OpenCascade runs in the browser — this can take a moment</small>
              )}
            </div>
          )}

          {state === "error" && (
            <div className="model-viewer-overlay error" role="alert">
              <strong>This model could not be displayed</strong>
              <span>{error}</span>
              <small>The file is still attached to the order and can be replaced.</small>
            </div>
          )}
        </div>

        <footer className="model-viewer-foot">
          {stats ? (
            <>
              <span className="mono">{stats.triangles.toLocaleString()} triangles</span>
              <span className="mono">{stats.vertices.toLocaleString()} vertices</span>
              <span className="mono" title="Bounding box, in the file's own units">
                {stats.size.map(dim).join(" × ")}
              </span>
              {stats.missingTextures > 0 && (
                <span
                  className="model-warn"
                  title="The model refers to texture files that were not uploaded; it is shown with its plain material."
                >
                  {stats.missingTextures} texture{stats.missingTextures === 1 ? "" : "s"} not
                  uploaded
                </span>
              )}
            </>
          ) : (
            <span className="mono">{state === "error" ? "—" : "Reading…"}</span>
          )}
          <span className="model-viewer-hint">Drag to orbit · right-drag to pan · scroll to zoom</span>
          <button
            type="button"
            className="btn model-viewer-reset"
            onClick={() => setResetSignal((n) => n + 1)}
            disabled={state !== "ready"}
          >
            Reset view
          </button>
        </footer>

        <button
          ref={closeRef}
          type="button"
          className="image-viewer-close"
          onClick={onClose}
          aria-label="Close model"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}
