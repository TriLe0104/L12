"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

type Phase = "idle" | "armed" | "slash" | "shred";

type ClawApi = {
  active: boolean;
  arm: () => void;
  play: () => Promise<void>;
  disarm: () => void;
};

const ClawContext = createContext<ClawApi>({
  active: false,
  arm: () => {},
  play: async () => {},
  disarm: () => {},
});

/** Jagged vertical strips — stacked they look like the intact login, then they fall. */
const SHARDS = [
  { clip: "polygon(0 0, 16% 0, 13% 18%, 17% 36%, 11% 55%, 15% 74%, 10% 100%, 0 100%)", dx: "-14vw", rot: "-18deg" },
  { clip: "polygon(13% 0, 29% 0, 27% 16%, 31% 34%, 24% 52%, 28% 72%, 22% 100%, 10% 100%, 15% 74%, 11% 55%, 17% 36%, 13% 18%)", dx: "-7vw", rot: "-9deg" },
  { clip: "polygon(27% 0, 43% 0, 41% 20%, 46% 38%, 39% 58%, 44% 78%, 38% 100%, 22% 100%, 28% 72%, 24% 52%, 31% 34%, 27% 16%)", dx: "-2vw", rot: "6deg" },
  { clip: "polygon(41% 0, 57% 0, 55% 17%, 60% 37%, 53% 56%, 58% 76%, 52% 100%, 38% 100%, 44% 78%, 39% 58%, 46% 38%, 41% 20%)", dx: "3vw", rot: "-11deg" },
  { clip: "polygon(55% 0, 71% 0, 69% 19%, 74% 40%, 67% 59%, 73% 79%, 68% 100%, 52% 100%, 58% 76%, 53% 56%, 60% 37%, 55% 17%)", dx: "8vw", rot: "14deg" },
  { clip: "polygon(69% 0, 84% 0, 82% 21%, 87% 41%, 80% 61%, 86% 81%, 83% 100%, 68% 100%, 73% 79%, 67% 59%, 74% 40%, 69% 19%)", dx: "13vw", rot: "-8deg" },
  { clip: "polygon(82% 0, 100% 0, 100% 100%, 83% 100%, 86% 81%, 80% 61%, 87% 41%, 82% 21%)", dx: "18vw", rot: "16deg" },
] as const;

function fillShard(pane: HTMLElement, source: HTMLElement | null) {
  pane.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "claw-clone";
  wrap.style.width = `${window.innerWidth}px`;
  wrap.style.height = `${window.innerHeight}px`;
  if (source) {
    const clone = source.cloneNode(true) as HTMLElement;
    clone.removeAttribute("id");
    wrap.appendChild(clone);
  }
  pane.appendChild(wrap);
}

function PowerGrid() {
  return (
    <svg className="claw-power" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <linearGradient id="claw-bus" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#e10600" stopOpacity="0.15" />
          <stop offset="50%" stopColor="#ff4d45" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#e10600" stopOpacity="0.15" />
        </linearGradient>
        <filter id="claw-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g className="claw-power-fill" filter="url(#claw-glow)">
        {[180, 420, 780, 1020].map((x, i) => (
          <g key={x} className="claw-hall" style={{ animationDelay: `${i * 90}ms` }}>
            <rect x={x - 88} y="210" width="176" height="380" rx="4" />
            {Array.from({ length: 8 }, (_, r) => (
              <rect key={r} x={x - 78 + (r % 2) * 82} y={228 + Math.floor(r / 2) * 88} width="70" height="74" rx="2" />
            ))}
          </g>
        ))}
      </g>
      <g className="claw-power-bus" filter="url(#claw-glow)">
        <path className="bus" d="M40 160 H1160" />
        <path className="bus" d="M40 640 H1160" />
        <path className="bus" d="M180 160 V640" />
        <path className="bus" d="M420 160 V640" />
        <path className="bus" d="M780 160 V640" />
        <path className="bus" d="M1020 160 V640" />
        <path className="bus bus-hot" d="M180 400 H420 H780 H1020" />
        <path className="spark" d="M180 160 L210 210 L250 190 L300 250" />
        <path className="spark" d="M780 640 L820 590 L860 620 L920 540" />
        <path className="spark" d="M420 400 L470 360 L510 390 L560 330" />
      </g>
      <g className="claw-power-nodes">
        {[180, 420, 780, 1020].flatMap((x) =>
          [160, 400, 640].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="5" />),
        )}
      </g>
    </svg>
  );
}

export function ClawRevealProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const shardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const finishRef = useRef<(() => void) | null>(null);

  const clearShards = () => {
    for (const pane of shardRefs.current) pane?.replaceChildren();
  };

  const disarm = useCallback(() => {
    setPhase("idle");
    finishRef.current?.();
    finishRef.current = null;
    clearShards();
  }, []);

  const arm = useCallback(() => {
    const src = document.querySelector(".login") as HTMLElement | null;
    for (const pane of shardRefs.current) {
      if (pane) fillShard(pane, src);
    }
    setPhase("armed");
  }, []);

  const play = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      disarm();
      return Promise.resolve();
    }
    setPhase("slash");
    return new Promise<void>((resolve) => {
      finishRef.current = resolve;
      window.setTimeout(() => setPhase("shred"), 480);
      window.setTimeout(() => {
        setPhase("idle");
        resolve();
        finishRef.current = null;
        clearShards();
      }, 1750);
    });
  }, [disarm]);

  const active = phase !== "idle";

  return (
    <ClawContext.Provider value={{ active, arm, play, disarm }}>
      {children}
      <div className="claw-stage" data-phase={phase} aria-hidden={!active}>
        <PowerGrid />
        {SHARDS.map((shard, i) => (
          <div
            key={i}
            className="claw-pane"
            ref={(el) => {
              shardRefs.current[i] = el;
            }}
            style={
              {
                "--clip": shard.clip,
                "--dx": shard.dx,
                "--rot": shard.rot,
                "--delay": `${i * 55}ms`,
              } as CSSProperties
            }
          />
        ))}
        <svg className="claw-slashes" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M62 0 C48 28 40 58 28 100" />
          <path d="M70 0 C54 26 44 60 32 100" />
          <path d="M54 0 C42 30 34 62 22 100" />
          <path d="M78 0 C60 24 50 56 38 100" />
          <path d="M46 0 C36 32 28 64 16 100" />
        </svg>
        <img className="claw-paw" src="/brand/claw-paw.jpg" alt="" />
      </div>
    </ClawContext.Provider>
  );
}

export const useClawReveal = () => useContext(ClawContext);
