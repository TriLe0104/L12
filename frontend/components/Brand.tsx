/** L12 cat mark + wordmark. */
const MARK = "/brand/l12-mark.png";

export function BrandLockup({ width = 260 }: { width?: number }) {
  return (
    <div className="brand-hero" style={{ width }}>
      <img src={MARK} alt="" className="brand-hero-mark" width={120} height={120} />
      <div className="brand-hero-word">
        <span className="brand-l12">L12</span>
        <span className="brand-app">APP</span>
      </div>
    </div>
  );
}

export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <span className="brand-mark">
      <img src={MARK} alt="L12" width={size} height={size} />
      <span className="brand-word">
        <span className="brand-l12">L12</span>
        <span className="brand-app">APP</span>
      </span>
    </span>
  );
}
