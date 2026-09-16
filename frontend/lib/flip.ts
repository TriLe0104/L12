/** FLIP: animate elements from where they *were* to where they now are.
 *
 * Cards move between kanban columns and re-sort in place. Without this they
 * teleport; with it every card that shifted slides to its new home.
 */

const SELECTOR = "[data-flip-id]";

export const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export type RectMap = Map<string, DOMRect>;

/** Read positions *before* the state change that moves things. */
export function captureRects(root: ParentNode | null): RectMap {
  const rects: RectMap = new Map();
  if (!root) return rects;
  for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
    if (el.dataset.flipId) rects.set(el.dataset.flipId, el.getBoundingClientRect());
  }
  return rects;
}

/** Ordered flip ids. Changes when nodes are added, removed or reordered, and
 *  stays put when only their text does — the difference between "this list
 *  moved" and "someone is typing in a label". */
export function rectSignature(rects: RectMap): string {
  return Array.from(rects.keys()).join("|");
}

/** Play the difference once the DOM has settled. */
export function playFlip(
  root: ParentNode | null,
  before: RectMap,
  { skip, duration = 300 }: { skip?: string | null; duration?: number } = {},
) {
  if (!root || prefersReducedMotion()) return;

  for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
    const id = el.dataset.flipId;
    // no "before" means the card just appeared — let its own entrance play
    if (!id || id === skip) continue;
    const from = before.get(id);
    if (!from) continue;

    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

    el.animate(
      [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
      { duration, easing: EASE_OUT },
    );
  }
}

/** Leaderboard shuffle: risers slide over fallers, staggered from the top. */
export function playRankFlip(
  root: ParentNode | null,
  before: RectMap,
  { duration = 920, stagger = 16 }: { duration?: number; stagger?: number } = {},
) {
  if (!root || prefersReducedMotion()) return;

  const els = Array.from(root.querySelectorAll<HTMLElement>(SELECTOR));
  els.forEach((el, i) => {
    const id = el.dataset.flipId;
    if (!id) return;
    const from = before.get(id);
    if (!from) {
      el.animate(
        [
          { opacity: 0, transform: "translate3d(0, 10px, 0)" },
          { opacity: 1, transform: "translate3d(0, 0, 0)" },
        ],
        { duration: 420, delay: i * stagger, easing: EASE_OUT, fill: "both" },
      );
      return;
    }

    const to = el.getBoundingClientRect();
    const dy = from.top - to.top;
    if (Math.abs(dy) < 1) return;

    const rose = dy > 0;
    const travel = Math.min(1, Math.abs(dy) / 420);
    const dur = duration + travel * 280;
    el.style.zIndex = rose ? "3" : "1";
    const anim = el.animate(
      [
        { transform: `translate3d(0, ${dy}px, 0)`, offset: 0 },
        { transform: `translate3d(0, ${dy * 0.12}px, 0)`, offset: 0.72 },
        { transform: "translate3d(0, 0, 0)", offset: 1 },
      ],
      {
        duration: dur,
        delay: Math.min(i, 28) * stagger,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        fill: "both",
      },
    );
    anim.finished.then(() => {
      if (el.style.zIndex === "3" || el.style.zIndex === "1") el.style.zIndex = "";
    }).catch(() => {
      el.style.zIndex = "";
    });
  });
}
