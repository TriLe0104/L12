"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "@/lib/api";
import { canEditStatus, useAuth } from "@/lib/auth";
import { displayPartIndex, poShowingPart } from "@/lib/parts";
import type { PurchaseOrder } from "@/lib/types";
import { JobCard } from "./JobCard";

export function PartsCarousel({
  po,
  onClose,
  onUpdated,
}: {
  po: PurchaseOrder;
  onClose: () => void;
  onUpdated?: (saved: PurchaseOrder) => void;
}) {
  const { user } = useAuth();
  const canPick = canEditStatus(user);
  const parts = po.parts ?? [];
  const current = displayPartIndex(po);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const node = scrollerRef.current?.querySelector<HTMLElement>(`[data-slide="${current}"]`);
    node?.scrollIntoView({ inline: "center", block: "nearest", behavior: "auto" });
  }, [current]);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        onClose();
      }
      if (event.key === "ArrowRight") scrollBy(1);
      if (event.key === "ArrowLeft") scrollBy(-1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      root.style.overflow = previous;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, parts.length]);

  function scrollBy(delta: number) {
    const next = Math.min(Math.max(active + delta, 0), Math.max(parts.length - 1, 0));
    const node = scrollerRef.current?.querySelector<HTMLElement>(`[data-slide="${next}"]`);
    node?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    setActive(next);
  }

  function onScroll() {
    const root = scrollerRef.current;
    if (!root) return;
    const slides = [...root.querySelectorAll<HTMLElement>("[data-slide]")];
    if (slides.length === 0) return;
    const mid = root.scrollLeft + root.clientWidth / 2;
    let best = 0;
    let bestDist = Infinity;
    for (const slide of slides) {
      const center = slide.offsetLeft + slide.offsetWidth / 2;
      const dist = Math.abs(center - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = Number(slide.dataset.slide);
      }
    }
    setActive(best);
  }

  async function choose(index: number) {
    if (!canPick || busy) return;
    if (index === current) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api.setDisplayPart(po.id, index);
      onUpdated?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set current part");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="scrim parts-carousel-scrim"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="parts-carousel" role="dialog" aria-modal="true" aria-label="Parts">
        <header className="parts-carousel-head">
          <strong>
            {po.job_no} · {parts.length} parts
          </strong>
          <span className="parts-carousel-count">
            Part {active + 1} of {parts.length}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="parts-carousel-hint">
          {canPick
            ? "Swipe or scroll, then click a card to show it on the board for everyone."
            : "Swipe or scroll to browse parts."}
        </p>
        <div
          ref={scrollerRef}
          className="parts-carousel-track"
          onScroll={onScroll}
        >
          {parts.map((_, i) => {
            const face = poShowingPart(po, i);
            const isCurrent = i === current;
            return (
              <div
                key={i}
                className="parts-carousel-slide"
                data-slide={i}
                data-current={isCurrent}
                onClick={() => void choose(i)}
              >
                {isCurrent && <span className="parts-carousel-badge">Current</span>}
                <JobCard po={face} hideParts />
              </div>
            );
          })}
        </div>
        {parts.length > 1 && (
          <div className="parts-carousel-nav">
            <button type="button" className="btn" disabled={active <= 0} onClick={() => scrollBy(-1)}>
              Previous
            </button>
            <button
              type="button"
              className="btn"
              disabled={active >= parts.length - 1}
              onClick={() => scrollBy(1)}
            >
              Next
            </button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}
