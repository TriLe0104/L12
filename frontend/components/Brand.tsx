"use client";

import { useUiTheme } from "@/lib/ui-theme";

/** L12 cat mark + wordmark. Production mode uses a Libra scale and the name Libra. */
const MARK = "/brand/l12-mark.png";

function LibraMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={`brand-scc-mark${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path fill="currentColor" d="M16 3.2 12.8 8h6.4L16 3.2z" />
      <path fill="currentColor" d="M3.2 7.6h25.6v2.1H3.2z" />
      <path fill="currentColor" d="M14.9 9.2h2.2V26h-2.2z" />
      <path fill="currentColor" d="M10.6 26h10.8v2.2H10.6z" />
      <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" d="M8 9.6v3.4M24 9.6v3.4" />
      <path fill="currentColor" d="M3 13.4h10c.15 2.7-2 4.6-5 4.6s-5.15-1.9-5-4.6zm16 0h10c.15 2.7-2 4.6-5 4.6s-5.15-1.9-5-4.6z" />
    </svg>
  );
}

export function BrandLockup({ width = 260 }: { width?: number }) {
  const { theme, productName } = useUiTheme();
  return (
    <div className="brand-hero" style={{ width }}>
      {theme === "scc" ? (
        <LibraMark size={120} className="brand-hero-mark" />
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
      {theme === "scc" ? <LibraMark size={size} /> : <img src={MARK} alt={productName} width={size} height={size} />}
      <span className="brand-word">
        <span className="brand-l12">{productName}</span>
        {theme === "meow" ? <span className="brand-app">APP</span> : null}
      </span>
    </span>
  );
}
