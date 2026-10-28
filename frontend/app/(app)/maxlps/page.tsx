"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { PolicyField, PowerPolicyFields, usePowerLimiter } from "@/components/PowerLimiter";
import { api } from "@/lib/api";
import type { LoopTargetRack, MaxLpsGpu, MaxLpsShelf, MaxLpsView, ProvisionHop } from "@/lib/cluster";
import { formatKw, formatRackKw, formatW } from "@/lib/cluster";
import { captureFlipTops, playEntrySwap } from "@/lib/flip";
import "../cluster/cluster.css";
import "./maxlps.css";

const MIN_INTERVAL_MS = 1;
const MAX_INTERVAL_MS = 300_000;
const DEFAULT_INTERVAL_MS = 10_000;
const TABLE_MIN_MS = 1;
const TABLE_MAX_MS = 120_000;
const TABLE_DEFAULT_MS = 5_000;
const TABLE_KEY = "l12-ranking-ms";

function clampTableMs(ms: number): number {
  if (!Number.isFinite(ms)) return TABLE_DEFAULT_MS;
  return Math.min(TABLE_MAX_MS, Math.max(TABLE_MIN_MS, Math.round(ms)));
}

function intervalMsFromS(seconds: number | undefined): number {
  const ms = Math.round((seconds ?? DEFAULT_INTERVAL_MS / 1000) * 1000);
  if (!Number.isFinite(ms)) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));
}

function formatInterval(ms: number): string {
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function gpuErrorText(err: string | null | undefined): string {
  if (!err) return "";
  if (err === "power-reading-empty") return "BMC answered and PowerWatts was empty";
  if (err === "bmc-password-missing") return "BMC password missing";
  if (err === "pxe-hop-down") return "rack PXE is not connected";
  if (err === "no-gpu-metrics") return "BMC did not return GPU metrics";
  if (err.startsWith("HTTP ")) return `BMC ${err}`;
  return err;
}
const ROW_H = 34;
const SWAP_MS = 880;
const DELTA_PLAY_MS = 1250;

function useOnceDelta(value: number, enabled: boolean, floor: number) {
  const baseline = useRef<number | null>(null);
  const playing = useRef(false);
  const tid = useRef<number | null>(null);
  const [delta, setDelta] = useState(0);
  const [play, setPlay] = useState(0);

  useEffect(() => {
    if (!enabled) {
      if (tid.current) window.clearTimeout(tid.current);
      tid.current = null;
      playing.current = false;
      baseline.current = value;
      setDelta(0);
      return;
    }
    if (baseline.current == null || baseline.current < 0.05) {
      baseline.current = value;
      return;
    }
    if (playing.current) return;
    const d = value - baseline.current;
    if (Math.abs(d) < floor) {
      baseline.current = value;
      return;
    }
    playing.current = true;
    baseline.current = value;
    setDelta(d);
    setPlay((n) => n + 1);
    if (tid.current) window.clearTimeout(tid.current);
    tid.current = window.setTimeout(() => {
      playing.current = false;
      tid.current = null;
      setDelta(0);
    }, DELTA_PLAY_MS);
  }, [value, enabled, floor]);

  useEffect(
    () => () => {
      if (tid.current) window.clearTimeout(tid.current);
    },
    [],
  );

  return { delta, play };
}

function mergeRankBoard(prevIds: string[] | null, incoming: MaxLpsGpu[]): MaxLpsGpu[] {
  if (!incoming.length) return incoming;
  const byId = new Map(incoming.map((g) => [g.id, g]));
  if (!prevIds?.length) return incoming;
  const inSet = new Set(incoming.map((g) => g.id));
  const kept = prevIds.filter((id) => inSet.has(id));
  kept.sort((a, b) => {
    const ra = byId.get(a)?.rank ?? 0;
    const rb = byId.get(b)?.rank ?? 0;
    return ra - rb || a.localeCompare(b);
  });
  const have = new Set(kept);
  const board = kept.slice();
  for (const g of incoming) {
    if (have.has(g.id)) continue;
    const idx = board.findIndex((id) => (byId.get(id)?.rank ?? 0) > g.rank);
    if (idx === -1) board.push(g.id);
    else board.splice(idx, 0, g.id);
    have.add(g.id);
  }
  return board
    .slice(0, incoming.length)
    .map((id) => byId.get(id))
    .filter((g): g is MaxLpsGpu => Boolean(g));
}

function rankLabel(n: number) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return String(n);
}

type SortKey = "rank" | "delta" | "gpu" | "rack" | "watts" | "cap" | "minmax";

function barTone(gpu: MaxLpsGpu) {
  if (!gpu.enabled) return "off";
  const cap = gpu.setpoint_w || gpu.max_w || gpu.tdp_w;
  if (gpu.watts > cap + 8) return "max";
  if (cap > 1 && gpu.watts >= cap - 12) return "lim";
  if (gpu.watts <= gpu.min_w + 12) return "min";
  return "mid";
}

export default function MaxLpsPage() {
  const { data: power, setData: setPower } = usePowerLimiter(true, 0);
  const [view, setView] = useState<MaxLpsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hop, setHop] = useState<ProvisionHop | null>(null);
  const [rackId, setRackId] = useState<string | null>(null);
  const [openRacks, setOpenRacks] = useState<Record<string, boolean>>({});
  const [gpuId, setGpuId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [pending, setPending] = useState(false);
  const prevRank = useRef<Map<string, number>>(new Map());
  const prevWatts = useRef<Map<string, number>>(new Map());
  const sortKeyRef = useRef<SortKey>(sortKey);
  sortKeyRef.current = sortKey;
  const frozenIds = useRef<string[] | null>(null);
  const gpuIdRef = useRef<string | null>(null);
  gpuIdRef.current = gpuId;
  const loadGen = useRef(0);
  const loadBusy = useRef(false);
  const [loopReset, setLoopReset] = useState(0);
  const [loopMs, setLoopMs] = useState(DEFAULT_INTERVAL_MS);
  const [continuous, setContinuous] = useState(false);
  const [tableMs, setTableMs] = useState(TABLE_DEFAULT_MS);
  const [tableField, setTableField] = useState(String(TABLE_DEFAULT_MS));
  const tableMsRef = useRef(TABLE_DEFAULT_MS);
  const [ranking, setRanking] = useState<MaxLpsGpu[]>([]);
  const [tableTick, setTableTick] = useState(0);
  const [deltas, setDeltas] = useState<Record<string, number | "new">>({});
  const [wattDelta, setWattDelta] = useState<Record<string, number>>({});
  const [usedDelta, setUsedDelta] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(640);
  const listOuter = useRef<HTMLDivElement>(null);
  const prevUsed = useRef<number | null>(null);
  const pollMs = continuous
    ? Math.min(250, Math.max(MIN_INTERVAL_MS, loopMs))
    : Math.min(1000, Math.max(MIN_INTERVAL_MS, loopMs));
  const loopStepRef = useRef<number | null>(null);
  const reshuffleRef = useRef(false);
  const [wattTick, setWattTick] = useState(0);
  const metaRef = useRef<MaxLpsGpu[]>([]);
  const rankSigRef = useRef("");
  const [loopOff, setLoopOff] = useState<Set<string> | null>(null);
  const onLoopTargets = useCallback((racks: LoopTargetRack[]) => {
    const off = new Set<string>();
    for (const rack of racks) {
      for (const node of rack.nodes) {
        if (!node.on) off.add(`${rack.id}:${node.index}`);
      }
    }
    setLoopOff(off);
  }, []);

  const load = useCallback(async () => {
    if (loadBusy.current) return;
    loadBusy.current = true;
    const gen = ++loadGen.current;
    try {
      const next = await api.maxlps({ top: 0, rack_id: rackId });
      if (gen !== loadGen.current) return;
      const used = next.totals.used_kw ?? next.totals.shelf_kw ?? 0;
      const dUsed = prevUsed.current == null ? (next.totals.used_delta_kw ?? 0) : used - prevUsed.current;
      prevUsed.current = used;
      setUsedDelta(dUsed);
      setView(next);
      metaRef.current = next.gpus;
      setLoopMs(intervalMsFromS(next.algo?.interval_s));
      setContinuous(Boolean(next.algo?.continuous));
      const step = next.loop_step ?? next.tick ?? 0;
      if (loopStepRef.current == null || step !== loopStepRef.current) {
        loopStepRef.current = step;
        setLoopReset((n) => n + 1);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dynamic Power failed");
    } finally {
      loadBusy.current = false;
    }
  }, [rackId]);

  useEffect(() => {
    const stored = window.localStorage.getItem(TABLE_KEY);
    if (stored == null || stored === "") return;
    const raw = Number(stored);
    if (!Number.isFinite(raw)) return;
    const ms = clampTableMs(raw);
    tableMsRef.current = ms;
    setTableMs(ms);
    setTableField(String(ms));
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(id);
  }, [load, pollMs]);

  const publishRanking = useCallback(
    (rows: { id: string; watts: number; setpoint_w?: number | null; min_w?: number | null; max_w?: number | null }[]) => {
      const meta = metaRef.current;
      if (!meta.length || !rows.length) return;
      const live = new Map(rows.map((g) => [g.id, g]));
      const merged = meta.map((g) => {
        const row = live.get(g.id);
        return {
          ...g,
          watts: row ? row.watts : g.watts,
          setpoint_w: row?.setpoint_w ?? g.setpoint_w,
          min_w: row?.min_w ?? g.min_w,
          max_w: row?.max_w ?? g.max_w,
        };
      });
      merged.sort((a, b) => b.watts - a.watts || a.id.localeCompare(b.id));
      for (let i = 0; i < merged.length; i++) merged[i] = { ...merged[i], rank: i + 1 };
      const sig = merged.map((g) => `${g.id}:${g.watts}:${g.setpoint_w}:${g.in_loop === false ? 0 : 1}`).join("|");
      if (sig === rankSigRef.current) return;
      const firstBoard = prevRank.current.size === 0;
      const nextDelta: Record<string, number | "new"> = {};
      const nextWatt: Record<string, number> = {};
      const nextRanks = new Map<string, number>();
      const nextWatts = new Map<string, number>();
      for (const g of merged) {
        nextRanks.set(g.id, g.rank);
        nextWatts.set(g.id, g.watts);
        if (!firstBoard) {
          const was = prevRank.current.get(g.id);
          const prevW = prevWatts.current.get(g.id);
          const dw = prevW == null ? 0 : Math.round(g.watts - prevW);
          if (Math.abs(dw) >= 4) nextWatt[g.id] = dw;
          if (was == null) nextDelta[g.id] = "new";
          else if (was !== g.rank) nextDelta[g.id] = was - g.rank;
        }
      }
      prevRank.current = nextRanks;
      prevWatts.current = nextWatts;
      rankSigRef.current = sig;
      setDeltas(nextDelta);
      setWattDelta(nextWatt);
      if (sortKeyRef.current === "rank") reshuffleRef.current = true;
      else frozenIds.current = null;
      setRanking(merged);
      setTableTick((n) => n + 1);
      setWattTick((n) => n + 1);
    },
    [],
  );

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      if (stop) return;
      const started = performance.now();
      if (!metaRef.current.length) {
        timer = window.setTimeout(tick, Math.min(50, Math.max(TABLE_MIN_MS, tableMsRef.current)));
        return;
      }
      try {
        const rank = await api.maxlpsRanking();
        if (!stop) publishRanking(rank.gpus);
      } catch {
        /* keep the last board */
      }
      if (stop) return;
      const wait = Math.max(0, tableMsRef.current - (performance.now() - started));
      timer = window.setTimeout(tick, wait);
    };
    timer = window.setTimeout(tick, 0);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [publishRanking, tableMs]);

  function commitTable(raw: string) {
    const ms = clampTableMs(Number(raw));
    tableMsRef.current = ms;
    setTableMs(ms);
    setTableField(String(ms));
    window.localStorage.setItem(TABLE_KEY, String(ms));
  }

  const refreshHop = useCallback(async () => {
    try {
      const next = await api.provisionHop();
      setHop(next);
    } catch {
      /* hop status is optional */
    }
  }, []);

  useEffect(() => {
    void refreshHop();
    const id = window.setInterval(() => void refreshHop(), 4000);
    return () => window.clearInterval(id);
  }, [refreshHop]);

  useEffect(() => {
    const el = listOuter.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  async function setMode(mode: "static" | "dynamic", reset = false) {
    setPending(true);
    try {
      const next = await api.patchClusterPower({ mode, reset });
      setPower(next);
      await load();
    } finally {
      setPending(false);
    }
  }

  const topo = view?.topology;
  const totals = view?.totals;
  const selected = view?.racks.find((r) => r.id === rackId) ?? null;
  const locked = pending;
  const rackUsedKw = useMemo(
    () => (view?.racks ?? []).reduce((s, r) => s + (r.shelf_kw || 0), 0),
    [view?.racks],
  );
  const gpuUsedKw = useMemo(() => {
    const live = view?.totals?.gpu_kw ?? 0;
    if (live > 0) return live;
    const listed = (view?.gpus ?? []).reduce((s, g) => s + (g.watts || 0), 0) / 1000;
    if (listed > 0) return listed;
    return (view?.racks ?? []).reduce((s, r) => s + (r.gpu_kw || 0), 0);
  }, [view?.gpus, view?.racks, view?.totals?.gpu_kw]);
  const gpuSetpointKw = useMemo(() => {
    const live = view?.totals?.cap_kw ?? 0;
    if (live > 0) return live;
    return (view?.gpus ?? []).reduce((s, g) => s + (g.setpoint_w || 0), 0) / 1000;
  }, [view?.gpus, view?.totals?.cap_kw]);
  const minRackKw = power?.min_rack_kw ?? view?.min_rack_kw ?? 40;
  const maxRackKw = power?.max_rack_kw ?? view?.max_rack_kw ?? 135;
  const thresholdPct = power?.threshold_pct ?? power?.stay_under_pct ?? view?.threshold_pct ?? 80;
  const budgetKw = power?.total_budget_kw ?? view?.totals?.total_kw ?? view?.total_budget_kw ?? 0;
  const availableKw = budgetKw > 0 ? (budgetKw * thresholdPct) / 100 : (view?.totals?.available_kw ?? 0);
  const totalKw = budgetKw > 0 ? budgetKw : Math.max(availableKw, rackUsedKw, gpuUsedKw);
  const rackAvailKw = availableKw > 0 ? availableKw : totalKw;
  const gpuFrac = (view?.algo?.gpu_power_percent ?? 75) / 100;
  const gpuAvailKw =
    typeof view?.totals?.allowable_kw === "number"
      ? view.totals.allowable_kw
      : Math.max(0, availableKw - rackUsedKw) * gpuFrac;
  const gpuLeftKw =
    typeof view?.totals?.gpu_left_kw === "number" ? view.totals.gpu_left_kw : gpuAvailKw - gpuUsedKw;
  const rackHeadroomKw = availableKw - rackUsedKw;
  const overheadKw = useMemo(
    () => (view?.racks ?? []).reduce((s, r) => s + (r.overhead_kw || 0), 0),
    [view?.racks],
  );
  const nRacks = view?.racks?.length ?? 0;
  const nGpus = totals?.gpu_live || totals?.gpus_listed || (view?.gpus ?? []).length;
  const gpuLive = view?.totals?.gpu_source === "redfish" && gpuUsedKw >= 0.05;
  const rackLive = (view?.totals?.shelf_source === "redfish" || view?.totals?.shelf_source === "argus") && rackUsedKw >= 0.05;
  const rackFlash = useOnceDelta(rackUsedKw, rackLive, 0.5);
  const gpuFlash = useOnceDelta(gpuUsedKw, gpuLive, 0.5);
  const rackDelta = rackFlash.delta;
  const gpuDelta = gpuFlash.delta;

  const sortedGpus = useMemo(() => {
    const src = ranking;
    const dir = sortDir === "asc" ? 1 : -1;
    const dlt = (id: string) => {
      const d = deltas[id];
      return typeof d === "number" ? d : 0;
    };
    const sortOnce = (rows: MaxLpsGpu[]) => {
      rows.sort((a, b) => {
        let c = 0;
        switch (sortKey) {
          case "rank":
            c = a.rank - b.rank;
            break;
          case "delta":
            c = dlt(a.id) - dlt(b.id);
            break;
          case "gpu":
            c = (a.serial || "").localeCompare(b.serial || "", undefined, { numeric: true })
              || (a.slot ?? a.node) - (b.slot ?? b.node)
              || a.gpu - b.gpu;
            break;
          case "rack":
            c = (a.slot ?? a.node) - (b.slot ?? b.node)
              || (a.hostname || "").localeCompare(b.hostname || "", undefined, { numeric: true })
              || a.gpu - b.gpu;
            break;
          case "watts":
            c = a.watts - b.watts;
            break;
          case "cap":
            c = a.setpoint_w - b.setpoint_w;
            break;
          case "minmax":
            c = (a.max_w ?? a.tdp_w) - (b.max_w ?? b.tdp_w);
            break;
          default:
            c = a.rank - b.rank;
        }
        if (c === 0) c = a.rank - b.rank;
        return c * dir;
      });
      return rows;
    };
    const byId = new Map(src.map((g) => [g.id, g]));
    if (sortKey === "rank") {
      if (reshuffleRef.current) {
        reshuffleRef.current = false;
        const merged = mergeRankBoard(frozenIds.current, sortDir === "asc" ? src : sortOnce(src.slice()));
        frozenIds.current = merged.map((g) => g.id);
        return merged;
      }
      if (frozenIds.current?.length) {
        const have = new Set<string>();
        const ordered: MaxLpsGpu[] = [];
        for (const id of frozenIds.current) {
          const g = byId.get(id);
          if (!g) continue;
          ordered.push(g);
          have.add(id);
        }
        for (const g of src) {
          if (!have.has(g.id)) ordered.push(g);
        }
        frozenIds.current = ordered.map((g) => g.id);
        return ordered;
      }
      const rows = sortDir === "asc" ? src : sortOnce(src.slice());
      frozenIds.current = rows.map((g) => g.id);
      return rows;
    }
    if (frozenIds.current?.length) {
      const have = new Set<string>();
      const ordered: MaxLpsGpu[] = [];
      for (const id of frozenIds.current) {
        const g = byId.get(id);
        if (!g) continue;
        ordered.push(g);
        have.add(id);
      }
      for (const g of src) {
        if (!have.has(g.id)) ordered.push(g);
      }
      frozenIds.current = ordered.map((g) => g.id);
      return ordered;
    }
    const rows = sortOnce(src.slice());
    frozenIds.current = rows.map((g) => g.id);
    return rows;
  }, [ranking, sortKey, sortDir, deltas]);

  const selectedGpu = (gpuId && (view?.gpus ?? []).find((g) => g.id === gpuId)) || null;

  const onSelectGpu = useCallback((g: MaxLpsGpu) => {
    if (g.id === gpuIdRef.current) {
      gpuIdRef.current = null;
      setGpuId(null);
      return;
    }
    gpuIdRef.current = g.id;
    setGpuId(g.id);
    void load();
  }, [load]);

  function toggleSort(key: SortKey) {
    frozenIds.current = null;
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "watts" || key === "cap" || key === "delta" ? "desc" : "asc");
  }

  const shuffle = sortKey === "rank";
  const hopHosts = hop?.hosts?.length ? hop.hosts : hop?.connected && hop.host ? [hop.host] : [];

  return (
    <div className="maxlps-page" data-mona="maxlps">
      <header className="maxlps-head">
        <div>
          <p className="maxlps-kicker">
            {power?.mode === "static" ? "Monitoring · GPUs at max cap" : "Closed-loop GPU power"}
          </p>
          <h1>Dynamic Power</h1>
          <p>
            {topo
              ? `${topo.model} · ${topo.racks} racks · ${topo.nodes_per_rack} nodes/rack · ${topo.gpus_per_node} GPU/node · ${topo.gpu_count.toLocaleString()} GPU · TDP ${formatW(topo.gpu_tdp_w)}`
              : "GB300 NVL72"}
          </p>
        </div>
        <div className="lps-modes">
          <span
            className="maxlps-pxe"
            data-active={hop?.connected ? "true" : undefined}
            title={hopHosts.length ? `PXE ${hopHosts.join(", ")}` : "PXE servers saved in Provision"}
          >
            {hopHosts.length > 1 ? `PXE · ${hopHosts.length}` : hopHosts.length === 1 ? `PXE · ${hopHosts[0]}` : "PXE · Provision"}
          </span>
          <button type="button" data-active={power?.mode === "static"} disabled={locked} onClick={() => setMode("static")}>
            Static
          </button>
          <button type="button" data-active={power?.mode === "dynamic"} disabled={locked} onClick={() => setMode("dynamic")}>
            Dynamic Power
          </button>
        </div>
      </header>

      {error ? <p className="cluster-error">{error}</p> : null}

      <section className="maxlps-stats">
        <article data-lead="true">
          <span>Total rack</span>
          <b>
            {formatRackKw(rackUsedKw)}
            {Math.abs(rackDelta) >= 0.5 ? (
              <em key={`rd-${rackFlash.play}`} data-off={rackDelta >= 0 ? "up" : "down"}>
                {rackDelta > 0 ? "+" : ""}
                {formatRackKw(rackDelta)}
              </em>
            ) : null}
          </b>
          <small>
            {view?.totals?.shelf_source === "redfish"
              ? "BMC PowerShelf total_power_out"
              : view?.totals?.shelf_source === "down"
                ? "Power shelves not responding"
                : view?.totals?.shelf_source === "argus"
                  ? "Argus TotalPowerOut (fallback)"
                  : "No PSU readings"}
          </small>
        </article>
        <article>
          <span>GPU sum</span>
          <b>
            {formatRackKw(gpuUsedKw)}
            {Math.abs(gpuDelta) >= 0.5 ? (
              <em key={`gd-${gpuFlash.play}`} data-off={gpuDelta >= 0 ? "up" : "down"}>
                {gpuDelta > 0 ? "+" : ""}
                {formatRackKw(gpuDelta)}
              </em>
            ) : null}
          </b>
          <small>
            {view?.totals?.gpu_source === "redfish"
              ? `Σ ${(view.totals.gpu_live ?? 0).toLocaleString()} GPU · ${
                  view.totals.gpu_poll_age_s == null
                    ? "polling"
                    : view.totals.gpu_poll_age_s < 1.5
                      ? "live"
                      : `${Math.round(view.totals.gpu_poll_age_s)}s ago`
                }`
              : gpuErrorText(view?.totals?.gpu_error) || "No BMC Redfish readings yet"}
          </small>
        </article>
        <article data-free={rackHeadroomKw < 0 ? "over" : "ok"}>
          <span>Total available power</span>
          <b>{formatRackKw(rackHeadroomKw)}</b>
          <small>
            {thresholdPct.toFixed(0)}% × {formatRackKw(totalKw)} − rack {formatRackKw(rackUsedKw)}
          </small>
        </article>
        <article data-free={gpuLeftKw < 0 ? "over" : "ok"}>
          <span>GPU cap left</span>
          <b>{formatRackKw(Math.max(0, gpuLeftKw))}</b>
          <small>Total available × GPU power % − draw. An uncapped node is held at its BMC max.</small>
        </article>
      </section>

      <MixChart
        totalKw={totalKw}
        rackAvailKw={rackAvailKw}
        gpuAvailKw={gpuAvailKw}
        gpuSetpointKw={gpuSetpointKw}
        rackUsedKw={rackUsedKw}
        gpuUsedKw={gpuUsedKw}
        rackDelta={rackDelta}
        gpuDelta={gpuDelta}
        rackPlay={rackFlash.play}
        gpuPlay={gpuFlash.play}
        overheadKw={overheadKw}
        history={view?.history}
        nRacks={nRacks}
        nGpus={nGpus}
        minRackKw={minRackKw}
        maxRackKw={maxRackKw}
      />

      <div className="maxlps-grid">
        <aside className="maxlps-shelves">
          <header>
            <h2>Racks</h2>
            <p>
              {view?.totals?.shelf_source === "redfish"
                ? `BMC PowerShelf total_power_out${
                    view.totals.shelf_poll_age_s == null
                      ? ""
                      : view.totals.shelf_poll_age_s < 1.5
                        ? " · live"
                        : ` · ${Math.round(view.totals.shelf_poll_age_s)}s ago`
                  }`
                : view?.totals?.shelf_source === "down"
                  ? "Power shelves not responding · 0 kW"
                  : view?.totals?.shelf_source === "argus"
                    ? "Argus TotalPowerOut (fallback)"
                    : "Waiting for PowerShelf sensors through each rack's PXE"}
              {view?.totals?.shelf_source === "redfish" && view?.racks?.length ? ` · ${formatRackKw(rackUsedKw)} total` : ""}
            </p>
            {rackId ? (
              <button type="button" className="maxlps-clear" onClick={() => setRackId(null)}>
                All racks
              </button>
            ) : null}
          </header>
          <div className="maxlps-shelf-list">
            {[...(view?.racks ?? [])]
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((r) => (
                <ShelfRow
                  key={r.id}
                  rack={r}
                  active={r.id === rackId}
                  open={Boolean(openRacks[r.id])}
                  minKw={minRackKw}
                  maxKw={maxRackKw}
                  onSelect={() => setRackId(r.id === rackId ? null : r.id)}
                  onToggle={() => setOpenRacks((cur) => ({ ...cur, [r.id]: !cur[r.id] }))}
                />
              ))}
          </div>
        </aside>

        <section className="maxlps-gpus">
          <header>
            <h2>
              {rackId && selected
                ? `${selected.label} · ${topo?.gpus_per_rack ?? 72} GB300`
                : `Power ranking · ${(totals?.gpus_listed ?? 0).toLocaleString()} / ${(totals?.gpus_total || totals?.gpus_listed || 0).toLocaleString()} GPU`}
            </h2>
            <p>
              {`Ranking every ${formatInterval(tableMs)}`}
              {view?.totals?.gpu_error ? ` · ${gpuErrorText(view.totals.gpu_error)}` : ""}
              {" · green gain / red loss"}
            </p>
            <label className="maxlps-table-ms">
              Table
              <input
                type="number"
                min={TABLE_MIN_MS}
                max={TABLE_MAX_MS}
                step={1}
                value={tableField}
                aria-label="Power ranking refresh in milliseconds"
                title="How often this ranking list re-reads live watts and reorders, in milliseconds. 1 ms to 120 s. A read still running finishes before the next one starts. Redfish and cap updates keep using Frequency, or Continuous when that is on."
                onChange={(e) => setTableField(e.target.value)}
                onBlur={() => commitTable(tableField)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitTable(tableField);
                  }
                }}
              />
              <span className="lps-unit">ms</span>
            </label>
          </header>
          <div className="maxlps-gpu-cols">
            {(
              [
                ["rank", "#"],
                ["delta", "Δ"],
                ["gpu", "GPU SN"],
                ["rack", "Host"],
                ["watts", "W"],
                ["cap", "Cap"],
                ["minmax", "Min–max"],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                data-on={sortKey === key ? "true" : undefined}
                data-dir={sortKey === key ? sortDir : undefined}
                onClick={() => toggleSort(key)}
              >
                {label}
              </button>
            ))}
            <span>Range</span>
            <span>Curve</span>
          </div>
          <div
            className="maxlps-gpu-list"
            ref={listOuter}
            onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
          >
            {sortedGpus.length ? (
              <VirtualGpus
                gpus={sortedGpus}
                scroll={scroll}
                viewH={viewH}
                deltas={deltas}
                wattDelta={wattDelta}
                selectedId={gpuId}
                shuffle={shuffle}
                tick={tableTick}
                wattTick={wattTick}
                snap={tableMs < SWAP_MS}
                loopOff={loopOff}
                onSelect={onSelectGpu}
              />
            ) : (
              <div className="maxlps-gpu-empty">
                <p>No GPU power readings yet</p>
                <span>
                  {`Polling each rack through the PXE saved in Provision${view?.totals?.gpu_error ? ` · ${gpuErrorText(view.totals.gpu_error)}` : ""}.`}
                </span>
              </div>
            )}
          </div>
        </section>

        <aside className="maxlps-loop" data-mona="limiter">
          {selectedGpu ? (
            <GpuInspector
              gpu={selectedGpu}
              curve={selectedGpu.curve}
              wattDelta={wattDelta[selectedGpu.id] ?? 0}
              onClose={() => setGpuId(null)}
              onPatched={(next) => {
                setView(next);
              }}
            />
          ) : (
            <>
              <h2>{power?.mode === "static" ? "Monitor" : "Control loop"}</h2>
              {power?.mode === "static" ? (
                <p className="lps-event">Dynamic Power off — caps restored to BMC AllowableMax. Redfish watts still update.</p>
              ) : null}
              <RunOn onChange={onLoopTargets} onWritten={() => void load()} />
              {power ? (
                <PowerPolicyFields
                  data={power}
                  onChange={(d) => {
                    setPower(d);
                    void load();
                  }}
                  locked={locked}
                  compact
                />
              ) : (
                <p>Loading limiter…</p>
              )}
              <LoopFields
                intervalS={view?.algo?.interval_s ?? 10}
                continuous={Boolean(view?.algo?.continuous)}
                gpuPowerPct={view?.algo?.gpu_power_percent ?? 75}
                desiredCapPct={view?.algo?.desired_cap_percent ?? 80}
                gpuMinW={view?.algo?.gpu_min_w ?? 200}
                gpuMaxW={view?.algo?.gpu_max_w ?? 1200}
                locked={locked}
                onChange={() => void load()}
              />
              <p className="lps-event">
                tick {power?.tick ?? view?.tick ?? 0}
                {power?.last_event ? ` · ${power.last_event}` : ""}
                {continuous ? (
                  " · back to back"
                ) : (
                  <>
                    {" · next in "}
                    <EtaClock ms={loopMs} resetKey={loopReset} />
                  </>
                )}
              </p>
              {selected ? (
                <>
                  <dl className="maxlps-detail">
                    <div>
                      <dt>Rack input</dt>
                      <dd>{formatRackKw(selected.shelf_kw)}</dd>
                    </div>
                    <div>
                      <dt>GPUs</dt>
                      <dd>{formatKw(selected.gpu_kw)}</dd>
                    </div>
                    <div>
                      <dt>Overhead</dt>
                      <dd>{formatKw(selected.overhead_kw)}</dd>
                    </div>
                    <div>
                      <dt>SetPoint</dt>
                      <dd>{formatW(selected.setpoint_w)} / GPU</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="maxlps-hint">
                  {view?.algo
                    ? view.algo.continuous
                      ? "Click a GPU for process, curve, and per-GPU min/max · PowerWatts and caps run back to back"
                      : `Click a GPU for process, curve, and per-GPU min/max · every ${formatInterval(intervalMsFromS(view.algo.interval_s))}`
                    : "Click a GPU to inspect it."}
                </p>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function logApproach(min: number, current: number, n = 12) {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 1 : i / (n - 1);
    const logu = Math.log1p(9 * u) / Math.log(10);
    pts.push(min + (current - min) * logu);
  }
  return pts;
}

function plotY(v: number, vmin: number, vmax: number, h: number, pad: number) {
  const t = (v - vmin) / Math.max(vmax - vmin, 1e-6);
  return h - pad - Math.max(0, Math.min(1, t)) * (h - pad * 2);
}

function logY(v: number, vmin: number, vmax: number, h: number, pad: number) {
  const a = Math.log10(Math.max(v, vmin));
  const b = Math.log10(vmin);
  const c = Math.log10(Math.max(vmax, vmin * 10));
  const t = (a - b) / Math.max(c - b, 1e-6);
  return h - pad - t * (h - pad * 2);
}

function EtaClock({ ms, resetKey }: { ms: number; resetKey: number }) {
  const [left, setLeft] = useState(ms);
  useEffect(() => {
    setLeft(ms);
  }, [ms, resetKey]);
  useEffect(() => {
    const step = ms >= 1000 && ms % 1000 === 0 ? 1000 : Math.min(100, ms);
    const id = window.setInterval(() => setLeft((s) => Math.max(0, s - step)), step);
    return () => window.clearInterval(id);
  }, [resetKey, ms]);
  if (ms >= 1000 && ms % 1000 === 0) return <span>{Math.max(0, Math.round(left / 1000))}s</span>;
  return <span>{formatInterval(Math.max(0, left))}</span>;
}

function MixBar({
  title,
  countLabel,
  usedKw,
  capKw,
  totalKw,
  usedDelta,
  tick,
  tone,
  capName,
  endName = "Total",
  minKw,
  maxKw,
}: {
  title: string;
  countLabel: string;
  usedKw: number;
  capKw: number;
  totalKw: number;
  usedDelta: number;
  tick: number;
  tone: "racks" | "gpus";
  capName: string;
  endName?: string;
  minKw?: number;
  maxKw?: number;
}) {
  const fmt = formatRackKw;
  const scale = Math.max(totalKw, usedKw, capKw, 1);
  const usedPct = Math.min(100, (usedKw / scale) * 100);
  const capPct = Math.min(100, (capKw / scale) * 100);
  const minPct = minKw && minKw > 0 ? Math.min(100, (minKw / scale) * 100) : null;
  const maxPct = maxKw && maxKw > 0 ? Math.min(100, (maxKw / scale) * 100) : null;
  const freeKw = capKw - usedKw;
  const freePct = Math.max(0, (Math.max(0, freeKw) / scale) * 100);
  const overPct = usedKw > capKw ? Math.min(100, ((usedKw - capKw) / scale) * 100) : 0;
  const deltaFloor = 0.5;
  const showDelta = usedKw >= 0.05 && Math.abs(usedDelta) >= deltaFloor;
  const dPct = showDelta && scale > 0 ? (usedDelta / scale) * 100 : 0;
  const prevPct = Math.max(0, Math.min(100, usedPct - dPct));
  const gainLeft = Math.min(prevPct, usedPct);
  const gainWidth = Math.abs(usedPct - prevPct);
  const offLabel = showDelta ? `${usedDelta > 0 ? "+" : ""}${fmt(usedDelta)}` : "";
  const sumEdge = usedPct < 10 ? "start" : usedPct > 92 ? "end" : "mid";
  const band = minKw && usedKw > 0 && usedKw < minKw ? "under" : maxKw && usedKw > maxKw ? "over" : "ok";
  const showMin = minPct != null && minPct > 1.5 && minPct < 98.5 && (maxPct == null || Math.abs(minPct - maxPct) > 2);
  const showMax = maxPct != null && maxPct > 1.5 && maxPct < 98.5 && Math.abs(maxPct - capPct) > 1.5;
  return (
    <div className="maxlps-mix-row">
      <div className="maxlps-mix-head">
        <strong>{title}</strong>
        <span>{countLabel}</span>
        <div className="maxlps-mix-metrics">
          <b data-k="cap">
            {capName} {formatKw(capKw)}
          </b>
          <b data-k="total">
            {endName} {formatKw(totalKw)}
          </b>
        </div>
      </div>
      <div
        className="maxlps-mix-bar"
        data-readjust={offLabel ? "true" : undefined}
        title={`${title} sum ${fmt(usedKw)} · ${capName} ${formatKw(capKw)} · ${endName} ${formatKw(totalKw)}${minKw ? ` · min ${formatKw(minKw)}` : ""}${maxKw ? ` · max ${formatKw(maxKw)}` : ""}`}
      >
        {showDelta && usedDelta < -deltaFloor ? (
          <i
            key={`ghost-${tick}`}
            data-k="ghost"
            style={{ width: `${prevPct}%`, ["--hp-to" as string]: `${usedPct}%` }}
          />
        ) : null}
        <i data-k="used" data-scope={tone} data-band={band} style={{ width: `${usedPct}%` }} />
        {showDelta && usedDelta > deltaFloor && gainWidth > 0.3 ? (
          <i key={`heal-${tick}`} data-k="heal" style={{ left: `${gainLeft}%`, width: `${gainWidth}%` }} />
        ) : null}
        {overPct > 0 ? <i data-k="over" style={{ left: `${usedPct - overPct}%`, width: `${overPct}%` }} /> : null}
        <i data-k="free" style={{ left: `${usedPct}%`, width: `${freePct}%` }} />
        {showMin ? (
          <b data-k="min" style={{ left: `${minPct}%` }} title={`Min ${formatKw(minKw ?? 0)}`} />
        ) : null}
        {showMax ? (
          <b data-k="max" style={{ left: `${maxPct}%` }} title={`Max ${formatKw(maxKw ?? 0)}`} />
        ) : null}
        <b data-k="cap" style={{ left: `${capPct}%` }} title={`${capName} ${formatKw(capKw)}`} />
        <b data-k="total" title={`${endName} ${formatKw(totalKw)}`} />
        {offLabel ? (
          <em key={`d-${tick}`} data-off={usedDelta >= 0 ? "up" : "down"}>
            {offLabel}
          </em>
        ) : null}
      </div>
      <div className="maxlps-mix-marks">
        <span data-k="sum" data-edge={sumEdge} style={{ left: `${Math.min(usedPct, 100)}%` }}>
          Σ {fmt(usedKw)}
        </span>
      </div>
    </div>
  );
}

const MixChart = memo(function MixChart({
  totalKw,
  rackAvailKw,
  gpuAvailKw,
  gpuSetpointKw,
  rackUsedKw,
  gpuUsedKw,
  rackDelta,
  gpuDelta,
  rackPlay,
  gpuPlay,
  overheadKw,
  history,
  nRacks,
  nGpus,
  minRackKw,
  maxRackKw,
}: {
  totalKw: number;
  rackAvailKw: number;
  gpuAvailKw: number;
  gpuSetpointKw: number;
  rackUsedKw: number;
  gpuUsedKw: number;
  rackDelta: number;
  gpuDelta: number;
  rackPlay: number;
  gpuPlay: number;
  overheadKw: number;
  history: MaxLpsView["history"];
  nRacks: number;
  nGpus: number;
  minRackKw: number;
  maxRackKw: number;
}) {
  const w = 420;
  const h = 72;
  const pad = 4;
  const lines = useMemo(() => {
    const rows = [...(history ?? [])];
    rows.push({
      t: Date.now() / 1000,
      gpu_kw: gpuUsedKw,
      overhead_kw: overheadKw,
      shelf_kw: rackUsedKw,
      used_kw: rackUsedKw,
      available_kw: rackAvailKw,
      allowable_kw: gpuAvailKw,
    });
    const focus = rows.flatMap((p) => [p.used_kw ?? p.shelf_kw, p.gpu_kw]).filter((n) => n > 0);
    let ymin = focus.length ? Math.min(...focus) : 0;
    let ymax = focus.length ? Math.max(...focus) : Math.max(rackAvailKw, totalKw, 10);
    const span = Math.max(ymax - ymin, ymax * 0.08, 8);
    ymin = Math.max(0, ymin - span * 0.25);
    ymax = ymax + span * 0.2;
    const toPts = (pick: (p: (typeof rows)[number]) => number) => {
      if (rows.length < 2) return "";
      return rows
        .map((p, i) => {
          const x = pad + (i / Math.max(1, rows.length - 1)) * (w - pad * 2);
          const y = plotY(pick(p), ymin, ymax, h, pad);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
    };
    return {
      allow: toPts((p) => p.available_kw ?? p.allowable_kw ?? 0),
      gpuAllow: toPts((p) => p.allowable_kw ?? 0),
      used: toPts((p) => p.used_kw ?? p.shelf_kw),
      oh: toPts((p) => p.overhead_kw),
      gpu: toPts((p) => p.gpu_kw),
    };
  }, [history, totalKw, gpuUsedKw, rackUsedKw, overheadKw, rackAvailKw, gpuAvailKw]);
  return (
    <section className="maxlps-mix">
      <div className="maxlps-mix-bars">
        <MixBar
          title="Racks"
          countLabel={`${nRacks.toLocaleString()} · racks`}
          usedKw={rackUsedKw}
          capKw={rackAvailKw}
          totalKw={totalKw}
          usedDelta={rackDelta}
          tick={rackPlay}
          tone="racks"
          capName="Threshold"
          minKw={nRacks * minRackKw}
          maxKw={nRacks * maxRackKw}
        />
        <MixBar
          title="GPUs"
          countLabel={`${nGpus.toLocaleString()} · GB300`}
          usedKw={gpuUsedKw}
          capKw={gpuSetpointKw}
          totalKw={Math.max(gpuAvailKw, gpuUsedKw, gpuSetpointKw, 1)}
          usedDelta={gpuDelta}
          tick={gpuPlay}
          tone="gpus"
          capName="SetPoint"
          endName="Cap"
        />
        <ul>
          <li data-k="used">Rack sum {formatRackKw(rackUsedKw)}</li>
          <li data-k="gpu">GPU sum {formatRackKw(gpuUsedKw)}</li>
          <li data-k="oh">Overhead {formatRackKw(overheadKw)}</li>
          <li data-k="avail">GPU cap {formatRackKw(gpuAvailKw)}</li>
          <li data-k="total">Total {formatKw(totalKw)}</li>
        </ul>
      </div>
      <svg className="maxlps-spark" viewBox={`0 0 ${w} ${h}`} aria-label="Log power curve">
        <polyline data-k="allow" points={lines.allow} />
        <polyline data-k="gpuallow" points={lines.gpuAllow} />
        <polyline data-k="shelf" points={lines.used} />
        <polyline data-k="oh" points={lines.oh} />
        <polyline data-k="gpu" points={lines.gpu} />
      </svg>
    </section>
  );
});

function VirtualGpus({
  gpus,
  scroll,
  viewH,
  deltas,
  wattDelta,
  selectedId,
  shuffle,
  tick,
  wattTick,
  snap,
  loopOff,
  onSelect,
}: {
  gpus: MaxLpsGpu[];
  scroll: number;
  viewH: number;
  deltas: Record<string, number | "new">;
  wattDelta: Record<string, number>;
  selectedId: string | null;
  shuffle: boolean;
  tick: number;
  wattTick: number;
  snap: boolean;
  loopOff: Set<string> | null;
  onSelect: (gpu: MaxLpsGpu) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < gpus.length; i++) m.set(gpus[i].id, i);
    return m;
  }, [gpus]);
  const prevPos = useRef<Map<string, number>>(new Map());
  const prevTops = useRef<Map<string, number>>(new Map());
  const prevOrder = useRef<string>("");
  const prevWindow = useRef({ start: 0, end: 0 });
  const holdIds = useRef<Set<string>>(new Set());
  const [holdGen, setHoldGen] = useState(0);

  const start = Math.max(0, Math.floor(scroll / ROW_H) - 6);
  const end = Math.min(gpus.length, start + Math.ceil(viewH / ROW_H) + 12);
  const rows: { g: MaxLpsGpu; i: number; slide: boolean }[] = [];
  const seen = new Set<string>();
  const add = (g: MaxLpsGpu, i: number) => {
    if (seen.has(g.id)) return;
    const was = prevPos.current.get(g.id);
    const slide = shuffle && was != null && was !== i;
    rows.push({ g, i, slide });
    seen.add(g.id);
  };
  for (let i = start; i < end; i++) {
    const g = gpus[i];
    if (g) add(g, i);
  }
  if (selectedId) {
    const i = byId.get(selectedId);
    if (i != null) add(gpus[i], i);
  }
  if (shuffle) {
    const pw = prevWindow.current;
    for (const [id, was] of prevPos.current) {
      const i = byId.get(id);
      if (i == null || seen.has(id) || i === was) continue;
      const wasOn = was >= pw.start && was < pw.end;
      const nowOn = i >= start && i < end;
      if (wasOn || nowOn) add(gpus[i], i);
    }
    for (const id of holdIds.current) {
      const i = byId.get(id);
      if (i != null) add(gpus[i], i);
    }
    void holdGen;
  }

  const slots: number[] = [];
  for (let i = start; i < end; i++) slots.push(i);
  const orderKey = useMemo(() => gpus.map((g) => g.id).join("|"), [gpus]);

  useLayoutEffect(() => {
    const last = captureFlipTops(rootRef.current);
    if (!snap && prevOrder.current && prevOrder.current !== orderKey && prevTops.current.size) {
      playEntrySwap(rootRef.current, prevTops.current, { duration: SWAP_MS });
    }
    prevOrder.current = orderKey;
    prevTops.current = last;
  }, [orderKey, snap]);

  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (let i = 0; i < gpus.length; i++) next.set(gpus[i].id, i);
    if (shuffle && !snap) {
      const keep = new Set<string>();
      for (const row of rows) {
        if (row.slide) keep.add(row.g.id);
      }
      holdIds.current = keep;
      const t = window.setTimeout(() => {
        holdIds.current = new Set();
        setHoldGen((n) => n + 1);
      }, SWAP_MS + 280);
      prevPos.current = next;
      prevWindow.current = { start, end };
      return () => window.clearTimeout(t);
    }
    prevPos.current = next;
    prevWindow.current = { start, end };
  }, [gpus, shuffle, tick, start, end, snap]);
  return (
    <div
      ref={rootRef}
      className="maxlps-gpu-virt"
      data-snap={snap ? "true" : undefined}
      style={{ height: Math.max(gpus.length * ROW_H, viewH) }}
    >
      {slots.map((i) => {
        if (!gpus[i]) return null;
        const place = shuffle && i < 3 ? String(i + 1) : undefined;
        return (
          <div
            key={`place-${i}`}
            className="maxlps-place-slot"
            data-place={place}
            style={{ top: i * ROW_H, height: ROW_H }}
          />
        );
      })}
      <div className="maxlps-rank-overlay" aria-hidden>
        {slots.map((i) => {
          if (!gpus[i]) return null;
          const place = shuffle && i < 3 ? String(i + 1) : undefined;
          return (
            <span
              key={i}
              className="maxlps-rank-slot"
              data-place={place}
              style={{ top: i * ROW_H, height: ROW_H }}
            >
              {place ? rankLabel(i + 1) : String(i + 1)}
            </span>
          );
        })}
      </div>
      {rows.map(({ g, i }) => (
        <div
          key={g.id}
          className="maxlps-gpu-abs"
          data-flip-id={g.id}
          style={{ top: i * ROW_H, height: ROW_H }}
        >
          <GpuRow
            gpu={g}
            delta={deltas[g.id]}
            wattDelta={wattDelta[g.id] ?? 0}
            active={g.id === selectedId}
            tick={wattTick}
            off={loopOff ? loopOff.has(`${g.rack_id}:${g.node}`) : g.in_loop === false}
            onSelect={onSelect}
          />
        </div>
      ))}
    </div>
  );
}

function formatShelfKw(kw: number) {
  return formatRackKw(kw);
}

function ShelfRow({
  rack,
  active,
  open,
  minKw,
  maxKw,
  onSelect,
  onToggle,
}: {
  rack: MaxLpsShelf;
  active: boolean;
  open: boolean;
  minKw: number;
  maxKw: number;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const shelves = rack.shelves ?? [];
  const scale = Math.max(maxKw, 1);
  const allDown = shelves.length > 0 && shelves.every((s) => s.down);
  const pct = allDown ? 0 : Math.min(100, (rack.shelf_kw / scale) * 100);
  const minPct = Math.min(100, (Math.max(0, minKw) / scale) * 100);
  const band = allDown
    ? "down"
    : rack.shelf_kw > 0 && rack.shelf_kw < minKw - 0.05
      ? "under"
      : rack.shelf_kw > maxKw + 0.05
        ? "over"
        : "ok";
  const shelfCap = Math.max(...shelves.map((s) => s.kw), 0.1);
  return (
    <div className="maxlps-rack-block" data-open={open ? "true" : undefined}>
      <div
        className="maxlps-shelf"
        data-active={active ? "true" : undefined}
        data-hot={rack.hot ? "true" : undefined}
        data-band={band}
        data-off={rack.power_state === "off" || !rack.enabled ? "true" : undefined}
      >
        <button
          type="button"
          className="maxlps-rack-tri"
          aria-expanded={open}
          aria-label={open ? `Collapse ${rack.label} power shelves` : `Expand ${rack.label} power shelves`}
          disabled={!shelves.length}
          onClick={onToggle}
        >
          <i aria-hidden />
        </button>
        <button type="button" className="maxlps-shelf-main" onClick={onSelect}>
          <span className="maxlps-shelf-id">{rack.label}</span>
          <span
            className="maxlps-shelf-bar"
            aria-hidden
            data-band={band}
            title={
              allDown
                ? "Power shelves not responding"
                : `${formatRackKw(rack.shelf_kw)} · min ${formatKw(minKw)} · max ${formatKw(maxKw)}`
            }
          >
            <i data-k="ps" data-band={band} style={{ width: `${pct}%` }} />
            {minPct > 2 && minPct < 98 ? <b data-k="min" style={{ left: `${minPct}%` }} /> : null}
          </span>
          <span className="maxlps-shelf-kw" title="Sum of power shelves">
            {formatRackKw(rack.shelf_kw)}
          </span>
        </button>
      </div>
      {open && shelves.length ? (
        <ul className="maxlps-ps-list">
          {shelves.map((s) => {
            const mods = s.psus ?? [];
            const down = Boolean(s.down);
            return (
              <li key={s.id}>
                <div className="maxlps-ps" data-down={down ? "true" : undefined}>
                  <span />
                  <span className="maxlps-shelf-id">PS{s.index}</span>
                  <span className="maxlps-shelf-bar" data-band={down ? "down" : undefined} aria-hidden>
                    <i
                      data-k="ps"
                      data-band={down ? "down" : undefined}
                      style={{ width: down ? "0%" : `${Math.min(100, (s.kw / shelfCap) * 100)}%` }}
                    />
                  </span>
                  <span className="maxlps-shelf-kw">{formatShelfKw(down ? 0 : s.kw)}</span>
                </div>
                {mods.map((p) => (
                  <div key={p.id} className="maxlps-ps maxlps-ps-mod">
                    <span />
                    <span className="maxlps-shelf-id">PSU{p.index}</span>
                    <span className="maxlps-shelf-bar" aria-hidden>
                      <i data-k="ps" style={{ width: `${Math.min(100, (p.kw / Math.max(s.kw, 0.1)) * 100)}%` }} />
                    </span>
                    <span className="maxlps-shelf-kw">{formatShelfKw(p.kw)}</span>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function RunOn({
  onChange,
  onWritten,
}: {
  onChange: (racks: LoopTargetRack[]) => void;
  onWritten?: () => void;
}) {
  const [racks, setRacks] = useState<LoopTargetRack[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const writing = useRef(false);

  const load = useCallback(async () => {
    if (writing.current) return;
    try {
      const next = await api.loopTargets();
      setRacks(next.racks);
      onChange(next.racks);
    } catch {
      /* keep the last list */
    }
  }, [onChange]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(id);
  }, [load]);

  async function patch(
    body: { racks?: { id: string; on: boolean }[]; nodes?: { id: string; on: boolean }[] },
    optimistic: LoopTargetRack[],
  ) {
    setRacks(optimistic);
    onChange(optimistic);
    writing.current = true;
    try {
      const next = await api.patchLoopTargets(body);
      setRacks(next.racks);
      onChange(next.racks);
      onWritten?.();
    } catch {
      writing.current = false;
      try {
        const next = await api.loopTargets();
        setRacks(next.racks);
        onChange(next.racks);
      } catch {
        /* leave the optimistic check */
      }
    } finally {
      writing.current = false;
    }
  }

  function toggleRack(rack: LoopTargetRack) {
    const on = !rack.nodes.every((n) => n.on);
    const optimistic = racks.map((r) =>
      r.id === rack.id ? { ...r, nodes: r.nodes.map((n) => ({ ...n, on })) } : r,
    );
    void patch({ racks: [{ id: rack.id, on }] }, optimistic);
  }

  function toggleNode(rack: LoopTargetRack, nodeId: string) {
    const node = rack.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const on = !node.on;
    const optimistic = racks.map((r) =>
      r.id === rack.id ? { ...r, nodes: r.nodes.map((n) => (n.id === nodeId ? { ...n, on } : n)) } : r,
    );
    void patch({ nodes: [{ id: nodeId, on }] }, optimistic);
  }

  const onCount = racks.reduce((sum, rack) => sum + rack.nodes.filter((n) => n.on).length, 0);
  const nodeCount = racks.reduce((sum, rack) => sum + rack.nodes.length, 0);

  return (
    <div className="maxlps-run">
      <div className="maxlps-run-head">
        <span>Run on</span>
        <span>
          {onCount} / {nodeCount}
        </span>
      </div>
      <p>Caps post only for checked nodes. Unchecked nodes still count in GPU power used, return to their BMC max, and that max comes off GPU cap left.</p>
      <div className="maxlps-run-list" role="group" aria-label="Racks and nodes in the control loop">
        {racks.length ? (
          racks.map((rack) => {
            const rackOn = rack.nodes.filter((n) => n.on).length;
            const allOn = rack.nodes.length > 0 && rackOn === rack.nodes.length;
            const mixed = rackOn > 0 && rackOn < rack.nodes.length;
            const isOpen = !!open[rack.id];
            return (
              <div key={rack.id}>
                <div className="maxlps-run-rack">
                  <button
                    type="button"
                    className="maxlps-run-exp"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${rack.label}`}
                    onClick={() => setOpen((s) => ({ ...s, [rack.id]: !isOpen }))}
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                  <input
                    type="checkbox"
                    checked={allOn}
                    ref={(el) => {
                      if (el) el.indeterminate = mixed;
                    }}
                    disabled={!rack.nodes.length}
                    aria-label={`Run dynamic power on ${rack.label}`}
                    onChange={() => toggleRack(rack)}
                  />
                  <span className="maxlps-run-name" title={rack.label}>
                    {rack.label}
                  </span>
                  <span className="maxlps-run-count">
                    {rackOn}/{rack.nodes.length}
                  </span>
                </div>
                {isOpen
                  ? rack.nodes.map((node) => (
                      <label key={node.id} className="maxlps-run-node">
                        <input
                          type="checkbox"
                          checked={node.on}
                          aria-label={`Run dynamic power on ${node.hostname || `node ${node.index}`} in ${rack.label}`}
                          onChange={() => toggleNode(rack, node.id)}
                        />
                        <span>{node.hostname || `Node ${node.index}`}</span>
                      </label>
                    ))
                  : null}
              </div>
            );
          })
        ) : (
          <p className="maxlps-run-empty">No racks in inventory.</p>
        )}
      </div>
    </div>
  );
}

function LoopFields({
  intervalS,
  continuous,
  gpuPowerPct,
  desiredCapPct,
  gpuMinW,
  gpuMaxW,
  locked,
  onChange,
}: {
  intervalS: number;
  continuous: boolean;
  gpuPowerPct: number;
  desiredCapPct: number;
  gpuMinW: number;
  gpuMaxW: number;
  locked?: boolean;
  onChange: () => void;
}) {
  const intervalMs = intervalMsFromS(intervalS);
  const [freq, setFreq] = useState(String(intervalMs));
  const [gpuPct, setGpuPct] = useState(String(Math.round(gpuPowerPct)));
  const [capPct, setCapPct] = useState(String(Math.round(desiredCapPct)));
  const [minW, setMinW] = useState(String(Math.round(gpuMinW)));
  const [maxW, setMaxW] = useState(String(Math.round(gpuMaxW)));
  const editing = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (editing.current) return;
    if (String(intervalMs) !== freq) setFreq(String(intervalMs));
    const g = String(Math.round(gpuPowerPct));
    if (g !== gpuPct) setGpuPct(g);
    const c = String(Math.round(desiredCapPct));
    if (c !== capPct) setCapPct(c);
    const mn = String(Math.round(gpuMinW));
    if (mn !== minW) setMinW(mn);
    const mx = String(Math.round(gpuMaxW));
    if (mx !== maxW) setMaxW(mx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, gpuPowerPct, desiredCapPct, gpuMinW, gpuMaxW]);

  async function commit(nextFreq = freq, nextGpu = gpuPct, nextCap = capPct, nextMin = minW, nextMax = maxW) {
    const interval_ms = Math.round(Number(nextFreq));
    const gpu_power_percent = Number(nextGpu);
    const desired_cap_percent = Number(nextCap);
    const gpu_min_w = Number(nextMin);
    const gpu_max_w = Number(nextMax);
    if (![interval_ms, gpu_power_percent, desired_cap_percent, gpu_min_w, gpu_max_w].every(Number.isFinite)) return;
    if (interval_ms < MIN_INTERVAL_MS || interval_ms > MAX_INTERVAL_MS) {
      setFreq(String(intervalMs));
      return;
    }
    if (gpu_power_percent < 10 || gpu_power_percent > 100) return;
    if (desired_cap_percent < 10 || desired_cap_percent > 100) return;
    if (gpu_min_w < 50 || gpu_max_w > 2000 || gpu_min_w > gpu_max_w) return;
    if (
      interval_ms === intervalMs &&
      gpu_power_percent === Math.round(gpuPowerPct) &&
      desired_cap_percent === Math.round(desiredCapPct) &&
      gpu_min_w === Math.round(gpuMinW) &&
      gpu_max_w === Math.round(gpuMaxW)
    ) {
      return;
    }
    try {
      await api.patchClusterPower({
        interval_s: interval_ms / 1000,
        gpu_power_percent,
        desired_cap_percent,
        gpu_min_w,
        gpu_max_w,
      });
      onChange();
    } catch {
      /* keep local fields */
    }
  }

  function bind(setter: (v: string) => void) {
    return {
      disabled: locked,
      onChange: (e: { target: { value: string } }) => setter(e.target.value),
      onKeyDown: (e: { key: string; preventDefault: () => void }) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        }
      },
    };
  }

  return (
    <form
      ref={formRef}
      className="lps-policy maxlps-loop-algo"
      onFocusCapture={() => {
        editing.current = true;
      }}
      onBlurCapture={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && formRef.current?.contains(next)) return;
        editing.current = false;
        void commit();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}
    >
      <PolicyField
        label="Continuous"
        tip="When on, the next PowerWatts read starts as soon as the previous one finishes, and PowerLimitWatts is sent the same way when the cap needs an update. Frequency still paces power shelves, and paces both calls when this is off. An unchanged cap, within 2 W, is not sent again."
      >
        <button
          type="button"
          className="maxlps-continuous"
          data-active={continuous ? "true" : "false"}
          aria-pressed={continuous}
          aria-label="Continuous PowerWatts and PowerLimitWatts"
          disabled={locked}
          onClick={() => {
            if (locked) return;
            void api
              .patchClusterPower({ continuous: !continuous })
              .then(() => onChange())
              .catch(() => undefined);
          }}
        >
          {continuous ? "On" : "Off"}
        </button>
      </PolicyField>
      <PolicyField
        label="Frequency"
        tip="How often live power is read, the GPU cap is calculated, and a new cap is sent, in milliseconds, when Continuous is off. 1 ms to 300 s. A read that is still running finishes before the next one starts. An unchanged cap is not sent again. Power shelves always use this."
      >
        <span className="lps-policy-pct">
          <input
            type="number"
            min={MIN_INTERVAL_MS}
            max={MAX_INTERVAL_MS}
            step={1}
            value={freq}
            aria-label="Control loop interval in milliseconds"
            {...bind(setFreq)}
          />
          <span className="lps-unit">ms</span>
        </span>
      </PolicyField>
      <PolicyField
        label="GPU power"
        tip="Percent of total available power used as the GPU cap. Total available is threshold × total minus the live rack draw. Caps refit to this on the next cap pass."
      >
        <span className="lps-policy-pct">
          <input
            type="number"
            min={10}
            max={100}
            step={1}
            value={gpuPct}
            aria-label="GPU power percent of total available power"
            {...bind(setGpuPct)}
          />
          %
        </span>
      </PolicyField>
      <PolicyField
        label="Desired cap"
        tip="Target load versus the posted cap. The cap stays above average draw and never reaches the GPU max you set."
      >
        <span className="lps-policy-pct">
          <input
            type="number"
            min={10}
            max={100}
            step={1}
            value={capPct}
            aria-label="Desired usage as a percent of posted GPU cap"
            {...bind(setCapPct)}
          />
          %
        </span>
      </PolicyField>
      <PolicyField
        label="GPU min"
        tip="Floor watts for every GPU. Idle draw and the lowest cap the loop will post."
      >
        <span className="lps-policy-pct">
          <input type="number" min={50} max={1400} step={10} value={minW} aria-label="GPU minimum watts" {...bind(setMinW)} />
          W
        </span>
      </PolicyField>
      <PolicyField
        label="GPU max"
        tip="Ceiling watts. The loop will not post a GPU cap above this value."
      >
        <span className="lps-policy-pct">
          <input type="number" min={50} max={1400} step={10} value={maxW} aria-label="GPU maximum watts" {...bind(setMaxW)} />
          W
        </span>
      </PolicyField>
    </form>
  );
}

const GpuRow = memo(function GpuRow({
  gpu,
  delta,
  wattDelta,
  active,
  tick,
  off,
  onSelect,
}: {
  gpu: MaxLpsGpu;
  delta?: number | "new";
  wattDelta: number;
  active?: boolean;
  tick: number;
  off?: boolean;
  onSelect: (gpu: MaxLpsGpu) => void;
}) {
  const tone = barTone(gpu);
  const span = Math.max(gpu.max_w ?? 0, gpu.setpoint_w, 1);
  const usedPct = Math.max(0, Math.min(100, (gpu.watts / span) * 100));
  const limPct = Math.max(0, Math.min(100, (gpu.setpoint_w / span) * 100));
  const minPct = Math.max(0, Math.min(100, (gpu.min_w / span) * 100));
  const dPct = (wattDelta / span) * 100;
  const prevPct = Math.max(0, Math.min(100, usedPct - dPct));
  const gainLeft = Math.min(prevPct, usedPct);
  const gainWidth = Math.abs(usedPct - prevPct);
  const flash = wattDelta > 3 ? "up" : wattDelta < -3 ? "down" : undefined;
  let deltaLabel = "–";
  let deltaDir: "up" | "down" | "new" | "flat" = "flat";
  if (delta === "new") {
    deltaLabel = "NEW";
    deltaDir = "new";
  } else if (typeof delta === "number" && delta > 0) {
    deltaLabel = `↑${delta}`;
    deltaDir = "up";
  } else if (typeof delta === "number" && delta < 0) {
    deltaLabel = `↓${Math.abs(delta)}`;
    deltaDir = "down";
  }
  const offLabel =
    Math.abs(wattDelta) >= 4 ? `${wattDelta > 0 ? "+" : ""}${Math.round(wattDelta)}` : "";
  return (
    <button
      type="button"
      className="maxlps-gpu"
      data-tone={tone}
      data-active={active ? "true" : undefined}
      data-loop={off ? "off" : undefined}
      aria-label={`${rankLabel(gpu.rank)} ${gpu.serial || "gpu"} ${gpu.hostname || gpu.rack_label}${off ? " not in the control loop" : ""}`}
      onClick={() => onSelect(gpu)}
    >
      <span className="maxlps-rank" aria-hidden />
      <span className="maxlps-delta" data-dir={deltaDir}>
        {deltaLabel}
      </span>
      <span className="maxlps-gid" title={gpu.serial || `GPU ${gpu.gpu}`}>
        {gpu.serial || `g${gpu.gpu}`}
      </span>
      <span className="maxlps-rack" title={gpu.hostname || gpu.rack_label}>
        {gpu.hostname || `slot${gpu.slot ?? gpu.node - 1}`}
      </span>
      <span className="maxlps-w" data-flash={flash} title={gpu.source === "redfish" ? "BMC EnvironmentMetrics" : "simulated"}>
        {formatW(gpu.watts)}
      </span>
      <span className="maxlps-lim">{formatW(gpu.setpoint_w)}</span>
      <span className="maxlps-minmax">
        {formatW(gpu.min_w)}–{formatW(gpu.max_w ?? gpu.setpoint_w)}
      </span>
      <span className="maxlps-meter" aria-hidden>
        <i data-k="floor" style={{ width: `${minPct}%` }} />
        {wattDelta < -3 ? (
          <i
            key={`ghost-${tick}`}
            data-k="ghost"
            style={{ width: `${prevPct}%`, ["--hp-to" as string]: `${usedPct}%` }}
          />
        ) : null}
        <i data-k="used" style={{ width: `${usedPct}%` }} />
        {wattDelta > 3 && gainWidth > 0.4 ? (
          <i
            key={`heal-${tick}`}
            data-k="heal"
            style={{ left: `${gainLeft}%`, width: `${gainWidth}%` }}
          />
        ) : null}
        <i data-k="min" style={{ left: `${minPct}%` }} />
        <i data-k="lim" style={{ left: `${limPct}%` }} />
        {offLabel ? (
          <em key={`d-${tick}`} data-off={wattDelta >= 0 ? "up" : "down"}>
            {offLabel}
          </em>
        ) : null}
      </span>
      <LogSpark
        points={gpu.spark}
        watts={gpu.watts}
        min={gpu.min_w}
        max={gpu.max_w ?? gpu.setpoint_w}
        cap={gpu.setpoint_w}
      />
    </button>
  );
});

function samplesOf(
  curve: MaxLpsGpu["curve"],
  watts: number,
  cap: number,
): { t: number; w: number; cap: number; min?: number; max?: number }[] {
  if (curve && curve.length) {
    if (typeof curve[0] === "number") {
      const t0 = Date.now() / 1000 - (curve.length - 1) * 0.25;
      return (curve as number[]).map((w, i) => ({ t: t0 + i * 0.25, w, cap }));
    }
    return (curve as { t: number; w: number; cap: number; min?: number; max?: number }[]).map((p) => ({
      t: p.t,
      w: p.w,
      cap: p.cap,
      min: p.min,
      max: p.max,
    }));
  }
  return [{ t: Date.now() / 1000, w: watts, cap }];
}

function capFailPctLabel(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0%";
  const clamped = Math.min(100, pct);
  return `${Number.isInteger(clamped) ? clamped : clamped.toFixed(1)}%`;
}

function GpuInspector({
  gpu,
  curve,
  wattDelta,
  onClose,
  onPatched,
}: {
  gpu: MaxLpsGpu;
  curve?: MaxLpsGpu["curve"];
  wattDelta: number;
  onClose: () => void;
  onPatched: (next: MaxLpsView) => void;
}) {
  const [minW, setMinW] = useState(String(Math.round(gpu.min_w)));
  const [maxW, setMaxW] = useState(String(Math.round(gpu.max_w ?? gpu.setpoint_w)));
  const [live, setLive] = useState<{
    watts: number;
    cap: number;
    min: number;
    max: number;
    curve: MaxLpsGpu["curve"];
    process?: string;
    workload?: string;
    workloadKind?: string;
    pid?: number;
    capPosts: number;
    capFails: number;
    capFailPct: number;
    capMs: number | null;
    readMs: number | null;
  }>(() => ({
    watts: gpu.watts,
    cap: gpu.setpoint_w,
    min: gpu.min_w,
    max: gpu.max_w ?? gpu.setpoint_w,
    curve: curve ?? gpu.curve,
    process: gpu.process,
    workload: gpu.workload,
    workloadKind: gpu.workload_kind,
    pid: gpu.pid,
    capPosts: 0,
    capFails: 0,
    capFailPct: 0,
    capMs: null,
    readMs: null,
  }));
  const editing = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const pullBusy = useRef(false);

  useEffect(() => {
    setLive({
      watts: gpu.watts,
      cap: gpu.setpoint_w,
      min: gpu.min_w,
      max: gpu.max_w ?? gpu.setpoint_w,
      curve: curve ?? gpu.curve,
      process: gpu.process,
      workload: gpu.workload,
      workloadKind: gpu.workload_kind,
      pid: gpu.pid,
      capPosts: 0,
      capFails: 0,
      capFailPct: 0,
      capMs: null,
      readMs: null,
    });
  }, [gpu.id]);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      if (pullBusy.current || stop) return;
      pullBusy.current = true;
      try {
        const data = await api.maxlpsGpuCurve(gpu.id);
        if (stop) return;
        setLive({
          watts: data.watts,
          cap: data.setpoint_w,
          min: data.min_w,
          max: data.max_w,
          curve: data.curve,
          process: data.process,
          workload: data.workload,
          workloadKind: data.workload_kind,
          pid: data.pid,
          capPosts: data.cap_posts ?? 0,
          capFails: data.cap_fails ?? 0,
          capFailPct: data.cap_fail_pct ?? 0,
          capMs: typeof data.cap_ms === "number" ? data.cap_ms : null,
          readMs: typeof data.read_ms === "number" ? data.read_ms : null,
        });
      } catch {
        /* keep last window */
      } finally {
        pullBusy.current = false;
      }
    };
    void pull();
    const id = window.setInterval(pull, 400);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [gpu.id]);

  useEffect(() => {
    if (editing.current) return;
    setMinW(String(Math.round(live.min ?? gpu.min_w)));
    setMaxW(String(Math.round(live.max ?? gpu.max_w ?? gpu.setpoint_w)));
  }, [gpu.id, live.min, live.max, gpu.min_w, gpu.max_w, gpu.setpoint_w]);

  async function commit() {
    const min_w = Number(minW);
    const max_w = Number(maxW);
    if (![min_w, max_w].every(Number.isFinite)) return;
    if (min_w < 50 || max_w > 2000 || min_w > max_w) return;
    if (min_w === Math.round(live.min) && max_w === Math.round(live.max)) return;
    try {
      const next = await api.patchMaxlpsGpu(gpu.id, { min_w, max_w });
      onPatched(next);
    } catch {
      /* keep local */
    }
  }

  const pts = samplesOf(live.curve ?? curve, live.watts, live.cap);
  const off =
    Math.abs(wattDelta) >= 4 ? `${wattDelta > 0 ? "+" : ""}${Math.round(wattDelta)} W` : "hold";

  return (
    <div className="maxlps-inspect">
      <header>
        <div>
          <p className="maxlps-kicker">GPU</p>
          <h2>
            {gpu.serial || `GPU ${gpu.gpu}`}
            {gpu.hostname ? ` · ${gpu.hostname}` : ""}
          </h2>
        </div>
        <button type="button" className="maxlps-clear" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="maxlps-inspect-rank">
        #{gpu.rank} · {formatW(live.watts)}
        {off !== "hold" ? ` · ${off}` : ""} · cap {formatW(live.cap)}
      </p>
      <dl className="maxlps-detail">
        <div>
          <dt>Process</dt>
          <dd>{live.process ?? gpu.process ?? "—"}</dd>
        </div>
        <div>
          <dt>PID</dt>
          <dd>{live.pid || gpu.pid ? live.pid || gpu.pid : "—"}</dd>
        </div>
        <div className="maxlps-inspect-span">
          <dt>Workload</dt>
          <dd title={live.workload && live.workload !== "—" ? live.workload : undefined}>
            {live.workload ?? gpu.workload ?? "—"}
            {(live.workloadKind ?? gpu.workload_kind) && (live.workloadKind ?? gpu.workload_kind) !== "idle"
              ? ` · ${live.workloadKind ?? gpu.workload_kind}`
              : ""}
          </dd>
        </div>
        <div className="maxlps-inspect-span">
          <dt>Cap posts</dt>
          <dd data-fail={live.capFails > 0 ? "true" : undefined}>
            {live.capPosts > 0 ? `${live.capFails} failed · ${capFailPctLabel(live.capFailPct)}` : "none yet"}
          </dd>
          <i
            className="maxlps-cap-fail"
            data-fail={live.capFails > 0 ? "true" : undefined}
            aria-hidden
          >
            <b style={{ width: `${Math.max(0, Math.min(100, live.capFailPct))}%` }} />
          </i>
        </div>
        <div>
          <dt>PowerWatts</dt>
          <dd
            aria-label="Latest live power response in milliseconds"
            title="How long the latest Redfish power read took to answer"
          >
            {formatResponseMs(live.readMs)}
          </dd>
        </div>
        <div>
          <dt>PowerLimitWatts</dt>
          <dd
            aria-label="Latest PowerLimitWatts response in milliseconds"
            title="How long the latest PowerLimitWatts SetPoint call took to answer"
          >
            {formatResponseMs(live.capMs)}
          </dd>
        </div>
      </dl>
      <DetailCurve samples={pts} min={live.min} max={live.max} cap={live.cap} watts={live.watts} />
      <form
        ref={formRef}
        className="lps-policy maxlps-loop-algo"
        onFocusCapture={() => {
          editing.current = true;
        }}
        onBlurCapture={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && formRef.current?.contains(next)) return;
          editing.current = false;
          void commit();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void commit();
        }}
      >
        <label>
          Min W
          <input
            type="number"
            min={50}
            max={1400}
            step={10}
            value={minW}
            aria-label="Minimum watts for this GPU"
            onChange={(e) => setMinW(e.target.value)}
          />
        </label>
        <label>
          Max W
          <input
            type="number"
            min={50}
            max={1400}
            step={10}
            value={maxW}
            aria-label="Maximum watts for this GPU"
            onChange={(e) => setMaxW(e.target.value)}
          />
        </label>
        <p>Applies to this GPU only. Max is the blue cap tick; the loop will not post above it.</p>
      </form>
    </div>
  );
}

function formatResponseMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const rounded = Math.round(ms);
  if (rounded < 1) return "<1 ms";
  return `${rounded} ms`;
}

function linY(v: number, lo: number, hi: number, h: number, pad: number) {
  const t = (v - lo) / Math.max(hi - lo, 1e-6);
  return h - pad - Math.max(0, Math.min(1, t)) * (h - pad * 2);
}

function DetailCurve({
  samples,
  min,
  max,
  cap,
  watts,
}: {
  samples: { t: number; w: number; cap: number }[];
  min: number;
  max: number;
  cap: number;
  watts: number;
}) {
  const w = 260;
  const h = 118;
  const padL = 36;
  const padR = 8;
  const padT = 14;
  const padB = 18;
  const lo = 0;
  const hi = Math.max(max, cap, watts, min, 10);
  const used = samples.length ? samples : [{ t: Date.now() / 1000, w: watts, cap }];
  const t0 = used[0].t;
  const t1 = used[used.length - 1].t;
  const span = Math.max(t1 - t0, 0.25);
  const xAt = (t: number) => padL + ((t - t0) / span) * (w - padL - padR);
  const yAt = (v: number) => linY(v, lo, hi, h, padT);
  const line = used.map((p) => `${xAt(p.t).toFixed(1)},${yAt(p.w).toFixed(1)}`).join(" ");
  const capLine = used.map((p) => `${xAt(p.t).toFixed(1)},${yAt(p.cap || cap).toFixed(1)}`).join(" ");
  const last = used[used.length - 1];
  const capY = yAt(cap);
  const minY = yAt(min);
  const xFirst = xAt(used[0].t);
  const xLast = xAt(last.t);
  const area = `${xFirst.toFixed(1)},${yAt(0).toFixed(1)} ${line} ${xLast.toFixed(1)},${yAt(0).toFixed(1)}`;
  return (
    <svg className="maxlps-detail-curve" viewBox={`0 0 ${w} ${h}`} aria-label="GPU power over time">
      <line data-k="axis" x1={padL} x2={padL} y1={padT} y2={h - padB} />
      <line data-k="axis" x1={padL} x2={w - padR} y1={h - padB} y2={h - padB} />
      <line data-k="max" x1={padL} x2={w - padR} y1={yAt(hi)} y2={yAt(hi)} />
      <line data-k="min" x1={padL} x2={w - padR} y1={minY} y2={minY} />
      <line data-k="cap" x1={padL} x2={w - padR} y1={capY} y2={capY} />
      <polygon data-k="fill" points={area} />
      <polyline data-k="capline" points={capLine} />
      <polyline data-k="used" points={line} />
      <circle data-k="now" cx={xLast} cy={yAt(last.w)} r="2.4" />
      <text x={padL - 4} y={Math.max(10, capY + 3)} textAnchor="end">
        {formatW(cap)}
      </text>
      <text x={padL - 4} y={Math.min(h - padB - 2, minY + 3)} textAnchor="end">
        {formatW(min)}
      </text>
      <text x={w - padR} y={h - 4} textAnchor="end">
        {used.length} samples
      </text>
    </svg>
  );
}

const LogSpark = memo(function LogSpark({
  points,
  watts,
  min,
  max,
  cap,
}: {
  points?: number[];
  watts?: number;
  min: number;
  max: number;
  cap: number;
}) {
  const w = 72;
  const h = 22;
  const pad = 1;
  const lo = Math.max(1, min * 0.8);
  const hi = Math.max(max, cap, 10);
  const series = points && points.length > 1 ? points : logApproach(min, watts ?? min, 8);
  if (series.length < 2) return <span className="maxlps-spark-mini" />;
  const line = series
    .map((v, i) => {
      const x = pad + (i / (series.length - 1)) * (w - pad * 2);
      const y = logY(v, lo, hi, h, pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const capY = logY(cap, lo, hi, h, pad);
  const minY = logY(min, lo, hi, h, pad);
  const maxY = logY(max, lo, hi, h, pad);
  return (
    <svg className="maxlps-spark-mini" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <line data-k="max" x1="0" x2={w} y1={maxY} y2={maxY} />
      <line data-k="min" x1="0" x2={w} y1={minY} y2={minY} />
      <line data-k="cap" x1="0" x2={w} y1={capY} y2={capY} />
      <polyline points={line} />
    </svg>
  );
});
