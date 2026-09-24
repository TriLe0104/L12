"use client";

import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import type { HallDetail, MaxLpsInvRack, MaxLpsShelf, PowerLimiter, PowerRack } from "@/lib/cluster";
import { formatRackKw } from "@/lib/cluster";
import { usePowerLimiter } from "@/components/PowerLimiter";

const NODES_PER_RACK = 18;
const SHELVES_PER_RACK = 8;
const POD_SPAN = 8;

type InfraView = "racks" | "devices";

type PodRack = {
  id: string;
  name: string;
  serial: string;
  hallId: string;
  row: number;
  col: number;
  consumedKw: number;
  capKw: number;
  nameplateKw: number;
  pct: number;
  partial: boolean;
  off: boolean;
  live: boolean;
  shelves: number;
};

type Pod = {
  id: string;
  index: number;
  name: string;
  hallId: string;
  hallName: string;
  line: number;
  room: number;
  racks: PodRack[];
};

function rackPos(name: string, x?: number, y?: number) {
  const m = name.match(/R(\d+)C(\d+)/i);
  if (m) return { row: Number(m[1]), col: Number(m[2]) };
  const row = Math.max(1, Math.floor(((y ?? 1) - 1) / 2) + 1);
  const col = Math.max(1, Math.round(x ?? 1));
  return { row, col };
}

function splitSerial(name: string) {
  const cleaned = name.replace(/^DH-\d+-/, "");
  if (cleaned.length <= 11) return [cleaned];
  const mid = Math.ceil(cleaned.length / 2);
  return [cleaned.slice(0, mid), cleaned.slice(mid)];
}

function formatDraw(kw: number) {
  const n = Number.isFinite(kw) ? kw : 0;
  if (Math.abs(n) >= 1000) {
    return `${(n / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MW`;
  }
  return `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kW`;
}

function IconPod() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="4" y="6" width="6" height="12" rx="1.2" fill="currentColor" opacity="0.85" />
      <rect x="14" y="4" width="6" height="16" rx="1.2" fill="currentColor" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M12 2.8a6.2 6.2 0 0 0-6.2 6.2c0 4.6 6.2 12.2 6.2 12.2s6.2-7.6 6.2-12.2A6.2 6.2 0 0 0 12 2.8zm0 8.4a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4z" />
    </svg>
  );
}

function IconRack() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="5" y="3" width="14" height="18" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 7h8M8 12h8M8 17h8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconPlug() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path fill="none" stroke="currentColor" strokeWidth="1.7" d="M8 4v6M16 4v6M6 10h12v3.2c0 3.2-2.4 5.8-6 6.6V22" />
    </svg>
  );
}

function toPodRack(
  id: string,
  name: string,
  serial: string,
  hallId: string,
  row: number,
  col: number,
  pr: PowerRack | undefined,
  lv: MaxLpsShelf | undefined,
  maxKw: number,
  powerKw: number,
): PodRack {
  const off = (pr?.power_state ?? "") === "off" || pr?.denied === true;
  const liveKw = lv?.shelf_kw ?? 0;
  const consumed = liveKw > 0.05 ? liveKw : (pr?.consumed_kw ?? powerKw ?? 0);
  const cap = Math.max(pr?.max_kw ?? 0, pr?.nameplate_kw ?? 0, pr?.allocated_kw ?? 0, maxKw, 1);
  const hasMeter = liveKw > 0.05 || (!off && (pr?.consumed_kw ?? powerKw ?? 0) > 0.05);
  const pct =
    pr?.usage_pct != null && Number.isFinite(pr.usage_pct)
      ? Math.max(0, Math.min(100, pr.usage_pct))
      : Math.max(0, Math.min(100, (consumed / cap) * 100));
  return {
    id,
    name,
    serial,
    hallId,
    row,
    col,
    consumedKw: off ? 0 : consumed,
    capKw: cap,
    nameplateKw: pr?.nameplate_kw || cap,
    pct: off ? 0 : pct,
    partial: off || Boolean(pr?.denied) || !hasMeter,
    off,
    live: liveKw > 0.05,
    shelves: lv?.shelf_count ?? SHELVES_PER_RACK,
  };
}

function buildPods(halls: HallDetail[], power: PowerLimiter | null, live: MaxLpsShelf[]): Pod[] {
  const liveById = new Map(live.map((r) => [r.id, r]));
  const powerById = new Map((power?.racks ?? []).map((r) => [r.id, r]));
  const maxKw = power?.max_rack_kw ?? 135;
  const roomOf = new Map(halls.map((h, i) => [h.id, i + 1] as const));

  const items: { hall: HallDetail; rack: HallDetail["racks"][number]; row: number; col: number }[] = [];
  for (const hall of halls) {
    for (const rack of hall.racks) {
      items.push({ hall, rack, ...rackPos(rack.name, rack.x, rack.y) });
    }
  }

  const buckets = new Map<string, typeof items>();
  for (const item of items) {
    const hallSize = item.hall.racks.length;
    const bank = hallSize <= 10 ? 0 : Math.floor((item.col - 1) / POD_SPAN);
    const key = hallSize <= 10 ? item.hall.id : `${item.hall.id}::r${item.row}::b${bank}`;
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }

  const keys = [...buckets.keys()].sort((a, b) => {
    const ia = buckets.get(a)![0];
    const ib = buckets.get(b)![0];
    return ia.hall.name.localeCompare(ib.hall.name) || ia.row - ib.row || ia.col - ib.col;
  });

  const pods: Pod[] = keys.map((key, index) => {
    const rows = buckets.get(key)!;
    rows.sort((a, b) => a.col - b.col || a.row - b.row);
    const hall = rows[0].hall;
    return {
      id: key,
      index: index + 1,
      name: `Pod ${index + 1}`,
      hallId: hall.id,
      hallName: hall.name,
      line: rows[0].row,
      room: roomOf.get(hall.id) ?? index + 1,
      racks: rows.map((item) =>
        toPodRack(
          item.rack.id,
          item.rack.name,
          powerById.get(item.rack.id)?.label || powerById.get(item.rack.id)?.name || item.rack.name,
          hall.id,
          item.row,
          item.col,
          powerById.get(item.rack.id),
          liveById.get(item.rack.id),
          maxKw,
          item.rack.power_kw,
        ),
      ),
    };
  });

  return pods;
}

function meteredKw(pr: PowerRack | undefined, lv: MaxLpsShelf | undefined) {
  const liveKw = lv?.shelf_kw ?? 0;
  const src = pr?.meter_source;
  const metered = src === "redfish" || src === "argus" || liveKw > 0.05;
  return { liveKw, metered, consumed: metered ? (liveKw > 0.05 ? liveKw : pr?.consumed_kw ?? 0) : 0 };
}

function podsFromRegistered(inv: MaxLpsInvRack[], power: PowerLimiter | null, live: MaxLpsShelf[]): Pod[] {
  const liveById = new Map(live.map((r) => [r.id, r]));
  const powerById = new Map((power?.racks ?? []).map((r) => [r.id, r]));
  const maxKw = power?.max_rack_kw ?? 135;
  const grouped = new Map<string, MaxLpsInvRack[]>();
  for (const rack of inv) {
    const key = (rack.hall || "").trim() || "live";
    const list = grouped.get(key) ?? [];
    list.push(rack);
    grouped.set(key, list);
  }

  const toRack = (rack: MaxLpsInvRack, col: number): PodRack => {
    const lv = liveById.get(rack.id);
    const pr = powerById.get(rack.id);
    const { consumed, metered } = meteredKw(pr, lv);
    const cap = Math.max(pr?.max_kw ?? 0, pr?.nameplate_kw ?? 0, maxKw, 1);
    const pct = Math.max(0, Math.min(100, (consumed / cap) * 100));
    const off = (pr?.power_state ?? rack.power_state) === "off" || !rack.enabled;
    return {
      id: rack.id,
      name: rack.label,
      serial: rack.label,
      hallId: rack.hall || "live",
      row: 1,
      col,
      consumedKw: off ? 0 : consumed,
      capKw: cap,
      nameplateKw: pr?.nameplate_kw || cap,
      pct: off ? 0 : pct,
      partial: off || !metered,
      off,
      live: metered,
      shelves: rack.shelf_count || SHELVES_PER_RACK,
    };
  };

  const pods: Pod[] = [];
  let index = 1;
  const halls = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [hall, racks] of halls) {
    for (let i = 0; i < racks.length; i += POD_SPAN) {
      const chunk = racks.slice(i, i + POD_SPAN);
      const n = index;
      const solo = halls.length === 1 && racks.length <= POD_SPAN;
      pods.push({
        id: `${hall}::${i}`,
        index: n,
        name: solo ? (hall === "live" ? "Live" : hall) : `Pod ${n}`,
        hallId: hall,
        hallName: hall === "live" ? "Live" : hall,
        line: Math.floor(i / POD_SPAN) + 1,
        room: n,
        racks: chunk.map((rack, col) => toRack(rack, col + 1)),
      });
      index += 1;
    }
  }
  return pods;
}

function RackColumn({ rack, devices }: { rack: PodRack; devices: boolean }) {
  const lines = splitSerial(rack.serial);
  const fill = Math.max(rack.partial ? 18 : 6, rack.pct);
  const kwLabel = rack.off || (rack.partial && rack.consumedKw < 0.05) ? "— kW" : formatRackKw(rack.consumedKw);
  return (
    <div className="pod-rack" data-partial={rack.partial ? "true" : undefined}>
      {devices ? (
        <div className="pod-rack-devices" aria-hidden>
          {Array.from({ length: Math.max(1, rack.shelves) }, (_, i) => (
            <i key={i} style={{ height: `${fill}%` }} />
          ))}
        </div>
      ) : (
        <div className="pod-rack-bar" title={`${rack.name} · ${kwLabel} of ${formatRackKw(rack.capKw)}`}>
          <span>{rack.partial ? "—" : `${Math.round(rack.pct)}%`}</span>
          {rack.partial ? <em className="pod-rack-ghost">Partial</em> : null}
          <i style={{ height: `${fill}%` }} />
        </div>
      )}
      <div className="pod-rack-id">
        {lines.map((line, i) => (
          <span key={`${i}-${line}`}>{line}</span>
        ))}
      </div>
      <b>{kwLabel}</b>
    </div>
  );
}

export function PodPowerBoard({
  halls = [],
  power,
}: {
  halls?: HallDetail[];
  power?: PowerLimiter | null;
}) {
  const local = usePowerLimiter(!power, 2000);
  const limiter = power ?? local.data;
  const [floor, setFloor] = useState<HallDetail[]>(halls);
  const [inv, setInv] = useState<MaxLpsInvRack[]>([]);
  const [live, setLive] = useState<MaxLpsShelf[]>([]);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState<InfraView>("racks");

  useEffect(() => {
    if (halls.length) setFloor(halls);
  }, [halls]);

  useEffect(() => {
    if (halls.length) return;
    let cancelled = false;
    api
      .campus()
      .then((c) => {
        if (!cancelled) setFloor(c.halls);
      })
      .catch(() => {
        /* limiter racks still group if campus is empty */
      });
    return () => {
      cancelled = true;
    };
  }, [halls.length]);

  useEffect(() => {
    let cancelled = false;
    const loadLive = () => {
      api
        .maxlps({ top: 1 })
        .then((d) => {
          if (!cancelled) setLive(d.racks ?? []);
        })
        .catch(() => {
          /* campus power still renders */
        });
    };
    const loadInv = () => {
      api
        .maxlpsInventory()
        .then((d) => {
          if (!cancelled) setInv(d.racks ?? []);
        })
        .catch(() => {
          /* floor halls remain the fallback */
        });
    };
    loadLive();
    loadInv();
    const liveId = window.setInterval(loadLive, 2000);
    const invId = window.setInterval(loadInv, 12000);
    return () => {
      cancelled = true;
      window.clearInterval(liveId);
      window.clearInterval(invId);
    };
  }, []);

  const pods = useMemo(
    () => (inv.length ? podsFromRegistered(inv, limiter, live) : buildPods(floor, limiter, live)),
    [inv, floor, limiter, live],
  );
  const shown = filter === "all" ? pods : pods.filter((p) => p.id === filter);
  const liveOn = live.some((r) => r.shelf_kw > 0.05) || (limiter?.active.consumed_kw ?? 0) > 0.05;

  return (
    <section className="pod-board">
      <div className="pod-infra">
        <header className="pod-infra-head">
          <h2>Live Infrastructure</h2>
          <div className="pod-board-live" data-on={liveOn ? "true" : undefined}>
            <i />
            Live telemetry
          </div>
        </header>

        <div className="pod-infra-bar">
          <div className="pod-tabs" role="tablist" aria-label="Pods">
            <button type="button" data-on={filter === "all"} onClick={() => setFilter("all")}>
              All Pods
            </button>
            {pods.map((p) => (
              <button key={p.id} type="button" data-on={filter === p.id} onClick={() => setFilter(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
          <div className="pod-view-toggle" role="tablist" aria-label="Infrastructure view">
            <button type="button" data-on={view === "racks"} onClick={() => setView("racks")}>
              <IconRack /> Racks
            </button>
            <button type="button" data-on={view === "devices"} onClick={() => setView("devices")}>
              <IconPlug /> Power devices
            </button>
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="pod-empty">No halls yet. Add racks on Floor to populate pods.</p>
        ) : (
          <div className="pod-grid" data-single={shown.length === 1 ? "true" : undefined}>
            {shown.map((pod) => {
              const used = pod.racks.reduce((s, r) => s + r.consumedKw, 0);
              const devices = pod.racks.reduce((s, r) => s + r.shelves, 0);
              const mapped = pod.racks.reduce((s, r) => s + r.nameplateKw, 0);
              const rated = pod.racks.filter((r) => !r.off).length;
              return (
                <article key={pod.id} className="pod-card">
                  <header>
                    <div>
                      <h3>
                        <IconPod /> {pod.name}
                      </h3>
                      <small>
                        <IconPin /> Line {pod.line}
                      </small>
                    </div>
                    <div className="pod-card-sum">
                      <b>{formatDraw(used)}</b>
                      <small>Room {pod.room || "—"}</small>
                    </div>
                  </header>
                  <div className="pod-racks" data-view={view}>
                    {pod.racks.map((rack) => (
                      <RackColumn key={rack.id} rack={rack} devices={view === "devices"} />
                    ))}
                  </div>
                  <footer>
                    <div>
                      <span>
                        {pod.racks.length} racks · {devices} power devices
                      </span>
                      <span>Mapped input {formatRackKw(mapped)}</span>
                    </div>
                    <div>
                      <span>{pod.racks.length * NODES_PER_RACK} configured nodes</span>
                      <span>
                        {rated}/{pod.racks.length} devices rated
                      </span>
                    </div>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
