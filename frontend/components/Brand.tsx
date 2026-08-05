import Image from "next/image";

/** Full TVM lockup (wordmark + "PRECISION MACHINING"). Needs a dark surface. */
export function BrandLockup({ width = 260 }: { width?: number }) {
  return (
    <Image
      src="/brand/tvm-logo.png"
      alt="TVM Precision Machining"
      width={631}
      height={211}
      priority
      style={{ width, height: "auto" }}
    />
  );
}

/** TVM mark only, for tight spots like the nav rail. */
export function BrandMark({ width = 132 }: { width?: number }) {
  return (
    <Image
      src="/brand/tvm-mark.png"
      alt="TVM"
      width={219}
      height={77}
      priority
      style={{ width, height: "auto" }}
    />
  );
}
