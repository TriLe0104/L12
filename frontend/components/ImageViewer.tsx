"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The full-size photo overlay: the drawer's own scrim with the picture resting
 *  on it at natural size, shrunk to fit the viewport so nothing is cropped.
 *
 *  Portalled to <body> so it clears the drawer's stacking context. React still
 *  routes events from a portal up the component tree, so every handler here
 *  stops propagation: without that, a click inside the viewer would also reach
 *  the card that opened it and pull the detail drawer open behind it. */
export function ImageViewer({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
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

  if (!mounted) return null;

  return createPortal(
    <div
      className="scrim image-viewer"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="image-viewer-frame" role="dialog" aria-modal="true" aria-label={alt}>
        {/* Plain <img>: uploads are served from the API origin, which next/image
            would only accept with a remotePatterns entry. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} />
        <button
          ref={closeRef}
          type="button"
          className="image-viewer-close"
          onClick={onClose}
          aria-label="Close photo"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}
