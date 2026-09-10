"use client";

import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import type { PowerLimiter as PowerLimiterData, PowerRack, PowerShowcaseSlot } from "@/lib/cluster";
import { formatKw } from "@/lib/cluster";

function barPct(kw: number, tdp: number) {
  if (tdp <= 0) return 0;
  return Math.max(0, Math.min(100, (kw / tdp) * 100));
}

function Stack({
  consumed,
  unused,
  tdp,
  denied,
  extra,
}: {
  consumed: number;
  unused: number;
  tdp: number;
  denied?: boolean;
  extra?: boolean;
}) {
  if (denied) {
    return (
      <div className="lps-stack" data-denied="true" title="No power budget for more rack">
        <span>No budget</span>
      </div>
    );
  }
  return (
    <div className="lps-stack" data-extra={extra ? "true" : undefined}>
      <i className="lps-unused" style={{ height: `${barPct(unused, tdp)}%` }} />
      <i className="lps-used" style={{ height: `${barPct(consumed, tdp)}%` }} />
    </div>
  );
}

function Slot({ slot, side }: { slot: PowerShowcaseSlot; side: "static" | "dynamic" }) {
  const row: PowerRack = slot[side];
  const denied = side === "static" && (slot.additional || row.denied) && row.allocated_kw <= 0;
  return (
    <div className="lps-slot" data-extra={row.extra ? "true" : undefined} data-denied={denied ? "true" : undefined}>
      <Stack
        consumed={row.consumed_kw}
        unused={row.unused_kw}
        tdp={row.nameplate_kw || 120}
        denied={denied}
        extra={row.extra}
      />
      <b>{denied ? "—" : `${Math.round(row.consumed_kw)} kW`}</b>
      <small>{slot.label}</small>
    </div>
  );
}

function Totals({
  title,
  kicker,
  consumed,
  budget,
  stranded,
  extra,
}: {
  title: string;
  kicker: string;
  consumed: number;
  budget: number;
  stranded: number;
  extra?: string;
}) {
  return (
    <header className="lps-head">
      <h2>{title}</h2>
      <p>
        {kicker}
        {extra ? ` · ${extra}` : ""}
      </p>
      <dl>
        <div>
          <dt>Consumed</dt>
          <dd>{formatKw(consumed)}</dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>{formatKw(budget)}</dd>
        </div>
        <div>
          <dt>Stranded</dt>
          <dd>{formatKw(stranded)}</dd>
        </div>
      </dl>
    </header>
  );
}

function Heat({ racks }: { racks: PowerRack[] }) {
  const on = racks.filter((r) => r.power_state !== "off");
  return (
    <div className="lps-heat" aria-label="All rack allocations">
      {on.map((r) => {
        const tdp = r.nameplate_kw || 120;
        if (r.denied || r.allocated_kw <= 0) {
          return <span key={r.id} className="lps-heat-cell" data-k="deny" title={`${r.label} · no budget`} />;
        }
        return (
          <span
            key={r.id}
            className="lps-heat-cell"
            data-k={r.extra ? "extra" : "on"}
            title={`${r.label} · ${Math.round(r.consumed_kw)} / ${Math.round(r.allocated_kw)} kW`}
          >
            <i style={{ height: `${barPct(r.unused_kw, tdp)}%` }} data-k="u" />
            <i style={{ height: `${barPct(r.consumed_kw, tdp)}%` }} data-k="c" />
          </span>
        );
      })}
    </div>
  );
}

export function PowerLimiterPanel({
  data,
  onChange,
  busy,
}: {
  data: PowerLimiterData | null;
  onChange?: (next: PowerLimiterData) => void;
  busy?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const locked = busy || pending;

  async function setMode(mode: "static" | "dynamic", reset = false) {
    setPending(true);
    try {
      const next = await api.patchClusterPower({ mode, reset });
      onChange?.(next);
    } finally {
      setPending(false);
    }
  }

  if (!data) return <section className="lps-row lps-pending">Loading power limiter…</section>;

  const extraN = data.dynamic.racks_extra;
  const extraLabel =
    extraN > 0 ? `+${extraN} additional rack${extraN === 1 ? "" : "s"} enabled` : "Reclaiming stranded allocation";

  return (
    <section className="lps-row">
      <div className="lps-toolbar">
        <div>
          <strong>Closed-loop power limiter</strong>
          <span>
            {formatKw(data.budget_kw)} DC budget · {data.policy.reduce_gap_pct}% slack reduces ·{" "}
            {data.policy.increase_gap_pct}% gap increases · leftover enables the next rack
          </span>
        </div>
        <div className="lps-modes">
          <button type="button" data-active={data.mode === "static"} disabled={locked} onClick={() => setMode("static")}>
            Static
          </button>
          <button
            type="button"
            data-active={data.mode === "dynamic"}
            disabled={locked}
            onClick={() => setMode("dynamic")}
          >
            MaxLPS
          </button>
          <button type="button" disabled={locked} onClick={() => setMode("dynamic", true)}>
            Replay
          </button>
        </div>
      </div>

      <article className="lps-panel" data-active={data.mode === "static"}>
        <Totals
          title="Static power allocation"
          kicker={`Total budget ${formatKw(data.budget_kw)}`}
          consumed={data.static.consumed_kw}
          budget={data.budget_kw}
          stranded={data.static.stranded_kw}
          extra={`${data.static.racks_denied} racks with no budget`}
        />
        <div className="lps-bars">
          {data.showcase.map((slot) => (
            <Slot key={`s-${slot.id}`} slot={slot} side="static" />
          ))}
        </div>
      </article>

      <article className="lps-panel" data-kind="dyn" data-active={data.mode === "dynamic"}>
        <Totals
          title="MaxLPS dynamic allocation"
          kicker={`Same ${formatKw(data.budget_kw)} budget`}
          consumed={data.dynamic.consumed_kw}
          budget={data.budget_kw}
          stranded={data.dynamic.stranded_kw}
          extra={extraLabel}
        />
        <div className="lps-bars">
          {data.showcase.map((slot) => (
            <Slot key={`d-${slot.id}`} slot={slot} side="dynamic" />
          ))}
        </div>
      </article>

      <aside className="lps-loop">
        <h2>Control loop</h2>
        <ol>
          <li>Collect rack power telemetry</li>
          <li>Find racks below their cap (&gt;{data.policy.reduce_gap_pct}% slack)</li>
          <li>Give unused watts to racks near the cap</li>
          <li>Validate the group stays inside the DC budget</li>
          <li>Spend leftover to enable the next rack</li>
        </ol>
        <dl>
          <div>
            <dt>Reduce</dt>
            <dd>{data.active.actions.reduce ?? 0}</dd>
          </div>
          <div>
            <dt>Hold</dt>
            <dd>{data.active.actions.hold ?? 0}</dd>
          </div>
          <div>
            <dt>Increase</dt>
            <dd>{data.active.actions.increase ?? 0}</dd>
          </div>
          <div>
            <dt>Enable</dt>
            <dd>{data.active.actions.enable ?? 0}</dd>
          </div>
        </dl>
        <p className="lps-event">
          tick {data.tick}
          {data.last_event ? ` · ${data.last_event}` : ""}
        </p>
        <Heat racks={data.racks} />
        <p className="lps-legend">
          <i data-k="c" /> Workload consumption
          <i data-k="u" /> Allocated unused
          <i data-k="d" /> No budget
          <i data-k="e" /> Extra rack
        </p>
      </aside>
    </section>
  );
}

export function usePowerLimiter(active: boolean) {
  const [data, setData] = useState<PowerLimiterData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = () => {
      api
        .clusterPower()
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Power limiter failed");
        });
    };
    load();
    const id = window.setInterval(load, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active]);

  const byId = useMemo(() => {
    const map: Record<string, PowerRack> = {};
    for (const r of data?.racks ?? []) map[r.id] = r;
    return map;
  }, [data]);

  return { data, error, setData, byId };
}
