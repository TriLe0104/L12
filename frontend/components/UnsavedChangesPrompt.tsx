"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The "you have unsaved changes" step between wanting the drawer gone and it
 *  going. Same portal, scrim, capture-phase Escape, scroll lock and focus
 *  return as ImageViewer and ModelViewer — this is the third of that family, not
 *  a second modal system.
 *
 *  Three ways out, not two. Clicking the scrim behind the drawer is very often
 *  an accident, so *nothing happens* has to be one of the answers, and it is the
 *  one Escape and a click on this prompt's own scrim both map to. The two that
 *  do close the drawer are spelled out in full on their buttons.
 */
export function UnsavedChangesPrompt({
  creating,
  busy,
  onSave,
  onDiscard,
  onCancel,
}: {
  /** a never-saved order: discarding loses the whole thing, not just an edit */
  creating: boolean;
  /** a save is in flight — the outcome is not settled, so nothing may be picked */
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  /* The viewport scroller is <html> here (both it and <body> are height:100%),
     so that is what has to be pinned. Its scrollbar is padded back in, or the
     page underneath would jump sideways as the prompt opens. */
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

  /* Focus lands on Keep editing — the one answer that cannot lose anything — and
     returns to whatever was focused in the drawer afterwards, so cancelling puts
     a keyboard user back at the field they were in. */
  useEffect(() => {
    if (!mounted) return;
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => opener?.focus?.();
  }, [mounted]);

  /* Capture phase, for the same reason the viewers use it: the drawer listens
     for Escape on the window too, and only the topmost layer should answer.
     Escape means cancel here — never the destructive outcome.

     Tab is trapped in the same handler: with the drawer still mounted and full
     of inputs behind this, an untrapped Tab would walk straight out of the
     prompt into a form the user has already been asked to decide about. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const frame = frameRef.current;
      if (!frame) return;
      const stops = [...frame.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      if (stops.length === 0) return;
      e.stopPropagation();
      const first = stops[0];
      const last = stops[stops.length - 1];
      const here = document.activeElement as HTMLElement | null;
      if (!here || !frame.contains(here)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && here === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && here === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="scrim confirm-scrim"
      onClick={(e) => {
        e.stopPropagation();
        // the scrim of a prompt about losing work can only ever mean "not yet"
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        ref={frameRef}
        className="confirm-frame"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        aria-describedby="unsaved-body"
        data-mode={creating ? "create" : "edit"}
      >
        <strong className="confirm-title" id="unsaved-title">
          {creating ? "Discard this new order?" : "Save your changes?"}
        </strong>
        <p className="confirm-body" id="unsaved-body">
          {creating
            ? "This order has not been created yet. Create it now, or discard it — nothing about it will be kept."
            : "This order has changes you have not saved yet. Save them, or discard them and close the drawer."}
        </p>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
            Keep editing
          </button>
          <button type="button" className="btn btn-danger" onClick={onDiscard} disabled={busy}>
            {creating ? "Discard new order" : "Discard changes"}
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : creating ? "Create and close" : "Save and close"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
