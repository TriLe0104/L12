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

/** Leaderboard shuffle: only rows in `only` move; risers slide over fallers. */
export function playRankFlip(
  root: ParentNode | null,
  before: RectMap,
  {
    duration = 920,
    stagger = 16,
    only,
  }: { duration?: number; stagger?: number; only?: Set<string> } = {},
) {
  if (!root || prefersReducedMotion() || before.size === 0) return;

  const els = Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) => {
    const id = el.dataset.flipId;
    if (!id || !before.has(id)) return false;
    if (only && !only.has(id)) return false;
    return true;
  });

  els.forEach((el, i) => {
    const id = el.dataset.flipId;
    if (!id) return;
    const from = before.get(id);
    if (!from) return;

    const to = el.getBoundingClientRect();
    const dy = from.top - to.top;
    if (Math.abs(dy) < 1) return;

    const rose = dy > 0;
    const travel = Math.min(1, Math.abs(dy) / 420);
    const dur = duration + travel * 220;
    el.style.zIndex = rose ? "4" : "2";
    const anim = el.animate(
      [
        { transform: `translate3d(0, ${dy}px, 0)`, offset: 0 },
        { transform: `translate3d(0, ${dy * 0.08}px, 0)`, offset: 0.78 },
        { transform: "translate3d(0, 0, 0)", offset: 1 },
      ],
      {
        duration: dur,
        delay: i * stagger,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        fill: "both",
      },
    );
    anim.finished
      .then(() => {
        el.style.zIndex = "";
      })
      .catch(() => {
        el.style.zIndex = "";
      });
  });
}

/** Slot tops relative to the list, so a scroll between ticks does not pollute dy. */
export function captureFlipTops(root: ParentNode | null): Map<string, number> {
  const tops = new Map<string, number>();
  if (!root) return tops;
  for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
    const id = el.dataset.flipId;
    if (id) tops.set(id, el.offsetTop);
  }
  return tops;
}

/** Dashboard ranking swap: invert each entry from its previous slot, then play
 *  a transform-only ease. Rank numbers live outside these nodes so they stay put. */
export function playEntrySwap(
  root: ParentNode | null,
  before: Map<string, number>,
  { duration = 860 }: { duration?: number } = {},
) {
  if (!root || prefersReducedMotion() || before.size === 0) return;

  for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
    const id = el.dataset.flipId;
    if (!id) continue;
    const from = before.get(id);
    if (from == null) {
      for (const anim of el.getAnimations()) anim.cancel();
      el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: Math.min(420, duration * 0.45),
        easing: EASE_OUT,
        fill: "both",
      });
      continue;
    }

    const dy = from - el.offsetTop;
    if (Math.abs(dy) < 1) continue;

    for (const anim of el.getAnimations()) anim.cancel();

    const rose = dy > 0;
    const dist = Math.abs(dy);
    const dur = duration + Math.min(180, dist * 0.18);
    el.style.zIndex = rose ? "6" : "3";
    el.dataset.flip = "1";
    const next = el.animate(
      [
        { transform: `translate3d(0, ${dy}px, 0)` },
        { transform: "translate3d(0, 0, 0)" },
      ],
      {
        duration: dur,
        easing: "cubic-bezier(0.25, 0.82, 0.18, 1)",
        fill: "both",
      },
    );
    next.finished
      .then(() => {
        el.style.zIndex = "";
        delete el.dataset.flip;
        next.cancel();
      })
      .catch(() => {
        el.style.zIndex = "";
        delete el.dataset.flip;
      });
  }
}

/** Ranking list: drag each moved row from its previous index to the new one.
 *  Works with virtualized rows as long as movers stay mounted. */
export function playListDrag(
  root: ParentNode | null,
  prevIndex: Map<string, number>,
  nextIndex: Map<string, number>,
  rowH: number,
  { duration = 1080 }: { duration?: number } = {},
) {
  if (!root || prefersReducedMotion() || prevIndex.size === 0) return;

  for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
    const id = el.dataset.flipId;
    if (!id) continue;
    const fromI = prevIndex.get(id);
    const toI = nextIndex.get(id);
    if (fromI == null || toI == null || fromI === toI) continue;
    const dy = (fromI - toI) * rowH;
    if (Math.abs(dy) < 2) continue;
    const rose = dy > 0;
    const dist = Math.abs(fromI - toI);
    const dur = duration + Math.min(420, dist * 14);
    const drift = rose ? 10 : -8;
    el.style.zIndex = rose ? "6" : "3";
    el.dataset.drag = "true";
    const anim = el.animate(
      [
        { transform: `translate3d(0, ${dy}px, 0)`, boxShadow: "0 2px 6px rgba(0,0,0,0.25)", offset: 0 },
        {
          transform: `translate3d(${drift}px, ${dy * 0.14}px, 0)`,
          boxShadow: "0 16px 28px rgba(0,0,0,0.5)",
          offset: 0.58,
        },
        { transform: "translate3d(0, 0, 0)", boxShadow: "0 0 0 rgba(0,0,0,0)", offset: 1 },
      ],
      { duration: dur, easing: "cubic-bezier(0.18, 0.72, 0.12, 1)", fill: "both" },
    );
    anim.finished
      .then(() => {
        el.style.zIndex = "";
        delete el.dataset.drag;
      })
      .catch(() => {
        el.style.zIndex = "";
        delete el.dataset.drag;
      });
  }
}
