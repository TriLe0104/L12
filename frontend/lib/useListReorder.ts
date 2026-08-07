"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  captureRects,
  EASE_OUT,
  playFlip,
  prefersReducedMotion,
  rectSignature,
  type RectMap,
} from "./flip";

const START_THRESHOLD = 4;
const LAND_MS = 220;

interface DragState {
  id: string;
  index: number;
  pointerId: number;
  handle: HTMLElement;
  row: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  originLeft: number;
  originTop: number;
  ghost: HTMLElement | null;
  active: boolean;
}

interface Options {
  onMove: (from: number, to: number) => void;
}

/** Pointer-driven list sorting with a carried clone and FLIP-settled rows. */
export function useListReorder({ onMove }: Options) {
  const rootRef = useRef<HTMLUListElement | null>(null);
  const previousRects = useRef<RectMap>(new Map());
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // Reordering re-renders the list, so onMove is a new closure over a new draft
  // every frame. The window listeners below are registered once per drag and
  // must always reach the current one.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const previousSignature = useRef<string | null>(null);
  // Set by animateNext() for the layout changes that aren't reorders — an
  // options panel opening pushes the rows below it down and should still slide.
  const forceFlip = useRef(false);
  const animateNext = useCallback(() => {
    forceFlip.current = true;
  }, []);

  useLayoutEffect(() => {
    const rects = captureRects(rootRef.current);
    const signature = rectSignature(rects);
    // Typing in a row's input reflows it without changing the row set, and
    // animating that turns every keystroke into a 220ms settle.
    const structural =
      previousSignature.current !== null && signature !== previousSignature.current;
    if (structural || forceFlip.current) {
      playFlip(rootRef.current, previousRects.current, {
        skip: dragging ? `setting:${dragging}` : null,
        duration: LAND_MS,
      });
    }
    forceFlip.current = false;
    previousSignature.current = signature;
    previousRects.current = rects;
  });

  const listeners = useRef<(() => void) | null>(null);

  const teardown = useCallback((removeGhost = true) => {
    const state = drag.current;
    drag.current = null;
    listeners.current?.();
    listeners.current = null;
    document.documentElement.classList.remove("is-dragging-setting");
    if (state?.handle.hasPointerCapture?.(state.pointerId)) {
      state.handle.releasePointerCapture(state.pointerId);
    }
    if (removeGhost) state?.ghost?.remove();
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const lift = useCallback((state: DragState) => {
    const rect = state.row.getBoundingClientRect();
    const ghost = state.row.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-flip-id");
    ghost.removeAttribute("data-reorder-index");
    ghost.removeAttribute("data-dragging");
    ghost.classList.add("settings-row-ghost");
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);

    state.ghost = ghost;
    state.originLeft = rect.left;
    state.originTop = rect.top;
    state.active = true;
    document.documentElement.classList.add("is-dragging-setting");
    setDragging(state.id);
    requestAnimationFrame(() => ghost.setAttribute("data-lifted", "true"));
  }, []);

  const moveGhost = (state: DragState) => {
    state.ghost?.style.setProperty(
      "transform",
      `translate3d(${state.x - state.startX}px, ${state.y - state.startY}px, 0)`,
    );
  };

  const rowUnderPointer = (state: DragState) => {
    const root = rootRef.current;
    if (!root) return null;
    // Only direct children — nested option lists also use data-reorder-index.
    for (const child of Array.from(root.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (!child.hasAttribute("data-reorder-index")) continue;
      if (child.dataset.reorderId === state.id) continue;
      const rect = child.getBoundingClientRect();
      if (state.y >= rect.top && state.y <= rect.bottom) return child;
    }
    return null;
  };

  const finish = useCallback(
    (commit: boolean) => {
      const state = drag.current;
      if (!state) return;
      if (!state.active) {
        teardown();
        return;
      }

      const ghost = state.ghost;
      teardown(false);
      const done = () => {
        ghost?.remove();
        setDragging(null);
      };
      if (!ghost || !commit || prefersReducedMotion()) {
        done();
        return;
      }

      requestAnimationFrame(() => {
        const destination = rootRef.current?.querySelector<HTMLElement>(
          `[data-reorder-id="${CSS.escape(state.id)}"]`,
        );
        const rect = destination?.getBoundingClientRect();
        ghost.removeAttribute("data-lifted");
        const fromX = state.x - state.startX;
        const fromY = state.y - state.startY;
        const animation = ghost.animate(
          [
            { transform: `translate3d(${fromX}px, ${fromY}px, 0)` },
            {
              transform: rect
                ? `translate3d(${rect.left - state.originLeft}px, ${rect.top - state.originTop}px, 0)`
                : `translate3d(${fromX}px, ${fromY}px, 0) scale(.98)`,
              opacity: rect ? 1 : 0,
            },
          ],
          { duration: LAND_MS, easing: EASE_OUT, fill: "forwards" },
        );
        animation.onfinish = done;
        animation.oncancel = done;
      });
    },
    [teardown],
  );

  const itemProps = (id: string, index: number) => ({
    "data-flip-id": `setting:${id}`,
    "data-reorder-id": id,
    "data-reorder-index": index,
    "data-dragging": dragging === id,
  });

  const handleProps = (id: string, index: number) => ({
    "aria-label": `Drag to reorder item ${index + 1}`,
    title: "Drag to reorder",
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || drag.current) return;
      const row = event.currentTarget.closest<HTMLElement>("[data-reorder-index]");
      if (!row) return;
      const handle = event.currentTarget;
      drag.current = {
        id,
        index,
        pointerId: event.pointerId,
        handle,
        row,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        originLeft: 0,
        originTop: 0,
        ghost: null,
        active: false,
      };

      // Reordering makes React re-insert the row, which silently drops pointer
      // capture on the handle inside it. Track the pointer on the window so the
      // drag survives every hop.
      const onPointerMove = (e: PointerEvent) => {
        const state = drag.current;
        if (!state || state.pointerId !== e.pointerId) return;
        state.x = e.clientX;
        state.y = e.clientY;
        if (!state.active) {
          if (Math.hypot(state.x - state.startX, state.y - state.startY) < START_THRESHOLD) {
            return;
          }
          lift(state);
        }
        e.preventDefault();
        moveGhost(state);
        const target = rowUnderPointer(state);
        const nextIndex = Number(target?.dataset.reorderIndex);
        if (!Number.isInteger(nextIndex) || nextIndex === state.index) return;
        onMoveRef.current(state.index, nextIndex);
        state.index = nextIndex;
      };
      const onPointerUp = (e: PointerEvent) => {
        if (drag.current?.pointerId === e.pointerId) finish(true);
      };
      const onPointerCancel = (e: PointerEvent) => {
        if (drag.current?.pointerId === e.pointerId) finish(false);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      listeners.current = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
      };

      handle.setPointerCapture?.(event.pointerId);
    },
  });

  return { rootRef, itemProps, handleProps, animateNext };
}
