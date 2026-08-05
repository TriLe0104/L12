"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { EASE_OUT, prefersReducedMotion } from "./flip";

/* Pointer-driven card dragging for the kanban board.
 *
 * The native HTML5 drag API hands the browser a frozen bitmap of the element
 * and fires dragover a few times a second, which reads as a stutter. Here the
 * card is lifted into a fixed-position clone that follows the pointer on every
 * frame, so the motion is as smooth as the display allows. */

const START_THRESHOLD = 6; // px of travel before a press counts as a drag
const EDGE_BAND = 90; // auto-scroll when the pointer gets this close to an edge
const EDGE_SPEED = 18;
const LAND_MS = 260;

interface DragState<S extends string> {
  id: string;
  from: S;
  pointerId: number;
  node: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  originLeft: number;
  originTop: number;
  ghost: HTMLElement | null;
  frame: number;
  active: boolean;
  target: S | null;
}

interface Options<S extends string> {
  enabled: boolean;
  /** the element that contains the `[data-stage]` drop targets */
  boardRef: React.RefObject<HTMLElement | null>;
  /** runs immediately before `onDrop`, while the DOM still shows the old layout */
  onBeforeDrop?: (id: string) => void;
  onDrop: (target: S, id: string) => void;
}

export function useBoardDrag<S extends string>({
  enabled,
  boardRef,
  onBeforeDrop,
  onDrop,
}: Options<S>) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<S | null>(null);
  const drag = useRef<DragState<S> | null>(null);
  const suppressClick = useRef(false);

  const teardown = useCallback((removeGhost: boolean) => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    cancelAnimationFrame(state.frame);
    document.documentElement.classList.remove("is-dragging-card");
    if (removeGhost) state.ghost?.remove();
    setOverStage(null);
  }, []);

  useEffect(() => () => teardown(true), [teardown]);

  const stageUnder = (x: number, y: number): S | null => {
    const board = boardRef.current;
    if (!board) return null;
    for (const col of board.querySelectorAll<HTMLElement>("[data-stage]")) {
      const r = col.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return (col.dataset.stage as S) ?? null;
      }
    }
    return null;
  };

  /** One animation frame of the lift: move the clone, scroll, re-test the target. */
  const tick = () => {
    const state = drag.current;
    if (!state?.active) return;

    if (state.ghost) {
      const dx = state.x - state.startX;
      const dy = state.y - state.startY;
      state.ghost.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    }

    // nudge the page when the card is held near the top or bottom edge
    const overshootTop = EDGE_BAND - state.y;
    const overshootBottom = state.y - (window.innerHeight - EDGE_BAND);
    if (overshootTop > 0) window.scrollBy(0, -Math.min(EDGE_SPEED, overshootTop / 4));
    else if (overshootBottom > 0) window.scrollBy(0, Math.min(EDGE_SPEED, overshootBottom / 4));

    const target = stageUnder(state.x, state.y);
    if (target !== state.target) {
      state.target = target;
      setOverStage(target);
    }

    state.frame = requestAnimationFrame(tick);
  };

  const lift = (state: DragState<S>) => {
    const rect = state.node.getBoundingClientRect();
    const ghost = state.node.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-flip-id");
    ghost.className = "card-ghost";
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);

    state.ghost = ghost;
    state.originLeft = rect.left;
    state.originTop = rect.top;
    state.active = true;

    // one frame later so the scale/rotate transition has something to run from
    requestAnimationFrame(() => ghost.setAttribute("data-lifted", "true"));

    document.documentElement.classList.add("is-dragging-card");
    setDragging(state.id);
    state.frame = requestAnimationFrame(tick);
  };

  /** Fly the clone to wherever the card ended up, then hand back to the real one. */
  const land = (state: DragState<S>) => {
    const { ghost, id } = state;
    if (!ghost) return setDragging(null);

    const fromX = state.x - state.startX;
    const fromY = state.y - state.startY;
    const done = () => {
      ghost.remove();
      setDragging(null);
    };

    if (prefersReducedMotion()) return done();

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const dest = document.querySelector<HTMLElement>(
          `[data-flip-id="${CSS.escape(id)}"]`,
        );
        const to = dest?.getBoundingClientRect();
        ghost.removeAttribute("data-lifted");

        const animation = ghost.animate(
          [
            { transform: `translate3d(${fromX}px, ${fromY}px, 0)` },
            {
              transform: to
                ? `translate3d(${to.left - state.originLeft}px, ${to.top - state.originTop}px, 0)`
                : `translate3d(${fromX}px, ${fromY}px, 0) scale(0.96)`,
              opacity: to ? 1 : 0,
            },
          ],
          { duration: LAND_MS, easing: EASE_OUT, fill: "forwards" },
        );
        animation.onfinish = done;
        animation.oncancel = done;
      }),
    );
  };

  const finish = (commit: boolean) => {
    const state = drag.current;
    if (!state) return;

    if (!state.active) {
      teardown(true);
      return; // never moved: leave it as a plain click
    }

    const target = commit ? state.target : null;
    suppressClick.current = true;
    teardown(false);

    if (target && target !== state.from) {
      onBeforeDrop?.(state.id);
      onDrop(target, state.id);
    }
    land(state);
  };

  const cancelRef = useRef(() => finish(false));
  cancelRef.current = () => finish(false);

  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging]);

  /** `movable` is the per-card veto — a locked order stays where it is. */
  const cardProps = (id: string, stage: S, movable = true) => ({
    "data-flip-id": id,
    "data-dragging": dragging === id,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      // a drag that ends on another card never gets its own click, so clear the
      // flag here rather than waiting for one that may not arrive
      suppressClick.current = false;
      if (!enabled || !movable || e.button !== 0 || drag.current) return;
      // let the card's own buttons, links and inputs behave normally
      if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;

      drag.current = {
        id,
        from: stage,
        pointerId: e.pointerId,
        node: e.currentTarget,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        originLeft: 0,
        originTop: 0,
        ghost: null,
        frame: 0,
        active: false,
        target: stage,
      };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== e.pointerId) return;

      state.x = e.clientX;
      state.y = e.clientY;
      if (state.active) return;

      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      // on touch, a mostly-vertical swipe belongs to the page, not to the card
      if (e.pointerType === "touch" && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null;
        return;
      }
      if (Math.hypot(dx, dy) < START_THRESHOLD) return;

      state.node.setPointerCapture(e.pointerId);
      lift(state);
    },
    onPointerUp: () => finish(true),
    onPointerCancel: () => finish(false),
    onClickCapture: (e: React.MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  });

  const columnProps = (stage: S) => ({
    "data-stage": stage,
    "data-dragover": overStage === stage && dragging !== null,
  });

  return { dragging, overStage, cardProps, columnProps };
}
