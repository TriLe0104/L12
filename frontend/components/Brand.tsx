"use client";

import { useUiTheme } from "@/lib/ui-theme";

/** L12 cat mark + wordmark. SCC mode uses a shield mark and SCC - Guarder. */
const MARK = "/brand/l12-mark.png";

function SccMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={`brand-scc-mark${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path
        fill="currentColor"
        d="M16 2.4 28 8.2v7.3c0 7.2-5.2 12.4-12 14.1C9.2 27.9 4 22.7 4 15.5V8.2L16 2.4zm0 3.1L7 9.3v6.2c0 5.6 3.9 9.7 9 11.1 5.1-1.4 9-5.5 9-11.1V9.3L16 5.5z"
      />
      <path fill="currentColor" d="M15.1 20.6 10.4 16l1.6-1.6 3.1 3.1 5-5.1 1.6 1.6z" />
    </svg>
  );
}

export function BrandLockup({ width = 260 }: { width?: number }) {
  const { theme, productName } = useUiTheme();
  return (
    <div className="brand-hero" style={{ width }}>
      {theme === "scc" ? (
        <SccMark size={120} className="brand-hero-mark" />
      ) : (
        <img src={MARK} alt="" className="brand-hero-mark" width={120} height={120} />
      )}
      <div className="brand-hero-word">
        <span className="brand-l12">{productName}</span>
        {theme === "meow" ? <span className="brand-app">APP</span> : null}
      </div>
    </div>
  );
}

export function BrandMark({ size = 34 }: { size?: number }) {
  const { theme, productName } = useUiTheme();
  return (
    <span className="brand-mark">
      {theme === "scc" ? <SccMark size={size} /> : <img src={MARK} alt={productName} width={size} height={size} />}
      <span className="brand-word">
        <span className="brand-l12">{productName}</span>
        {theme === "meow" ? <span className="brand-app">APP</span> : null}
      </span>
    </span>
  );
}
