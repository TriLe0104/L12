"use client";

import { useUiTheme } from "@/lib/ui-theme";

const MARK = "/brand/l12-mark.png";
const SCC_MARK = "/brand/supermicro.svg";

export function BrandLockup({ width = 260 }: { width?: number }) {
  const { theme, productName } = useUiTheme();
  return (
    <div className="brand-hero" style={{ width }}>
      {theme === "scc" ? (
        <img src={SCC_MARK} alt="Supermicro" className="brand-hero-mark brand-scc-logo" width={280} height={120} />
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
      {theme === "scc" ? (
        <img src={SCC_MARK} alt="Supermicro" className="brand-scc-logo" height={size} />
      ) : (
        <img src={MARK} alt={productName} width={size} height={size} />
      )}
      <span className="brand-word">
        <span className="brand-l12">{productName}</span>
        {theme === "meow" ? <span className="brand-app">APP</span> : null}
      </span>
    </span>
  );
}
