"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { PolicyField, PowerPolicyFields, usePowerLimiter } from "@/components/PowerLimiter";
import { ThemeDialog } from "@/components/ThemeDialog";
import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type { MaxLpsGpu, MaxLpsShelf, MaxLpsView, ProvisionHop } from "@/lib/cluster";
import { formatKw, formatRackKw, formatW } from "@/lib/cluster";
import { captureFlipTops, playEntrySwap } from "@/lib/flip";
import "../cluster/cluster.css";
import "./maxlps.css";

const DEFAULT_INTERVAL_MS = 10_000;
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
  const { user } = useAuth();
  const mayEdit = canEdit(user);
  const { data: power, setData: setPower } = usePowerLimiter(true, 0);
  const [view, setView] = useState<MaxLpsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hop, setHop] = useState<ProvisionHop | null>(null);
  const [hopOpen, setHopOpen] = useState(false);
  const [hopHost, setHopHost] = useState("172.25.231.244");
  const [hopUser, setHopUser] = useState("tril");
  const [hopPass, setHopPass] = useState("");
  const [hopBusy, setHopBusy] = useState(false);
  const hopAsked = useRef(false);
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
  const [loopReset, setLoopReset] = useState(0);
  const [loopSec, setLoopSec] = useState(DEFAULT_INTERVAL_MS / 1000);
  const [deltas, setDeltas] = useState<Record<string, number | "new">>({});
  const [wattDelta, setWattDelta] = useState<Record<string, number>>({});
  const [usedDelta, setUsedDelta] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(640);
  const listOuter = useRef<HTMLDivElement>(null);
  const prevUsed = useRef<number | null>(null);
  const pollMs = 1000;
  const loopStepRef = useRef<number | null>(null);
  const reshuffleRef = useRef(false);
  const [wattTick, setWattTick] = useState(0);

  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    try {
      const next = await api.maxlps({ top: 0, rack_id: rackId });
      if (gen !== loadGen.current) return;
      const firstBoard = prevRank.current.size === 0;
      const nextDelta: Record<string, number | "new"> = {};
      const nextWatt: Record<string, number> = {};
      const nextRanks = new Map<string, number>();
      const nextWatts = new Map<string, number>();
      for (const g of next.gpus) {
        nextRanks.set(g.id, g.rank);
        nextWatts.set(g.id, g.watts);
        if (firstBoard) continue;
        const was = prevRank.current.get(g.id);
        const prevW = prevWatts.current.get(g.id);
        const dw = prevW == null ? 0 : Math.round(g.watts - prevW);
        if (Math.abs(dw) >= 4) nextWatt[g.id] = dw;
        if (was == null) nextDelta[g.id] = "new";
        else if (was !== g.rank) nextDelta[g.id] = was - g.rank;
      }
      prevRank.current = nextRanks;
      prevWatts.current = nextWatts;
      const used = next.totals.used_kw ?? next.totals.shelf_kw ?? 0;
      const dUsed = prevUsed.current == null ? (next.totals.used_delta_kw ?? 0) : used - prevUsed.current;
      prevUsed.current = used;
      setDeltas(nextDelta);
      setWattDelta(nextWatt);
      setUsedDelta(dUsed);
      setView(next);
      setLoopSec(Math.max(1, Math.round(next.algo?.interval_s ?? 10)));
      setWattTick((n) => n + 1);
      const step = next.loop_step ?? next.tick ?? 0;
      if (loopStepRef.current == null || step !== loopStepRef.current) {
        loopStepRef.current = step;
        if (sortKeyRef.current === "rank") reshuffleRef.current = true;
        else frozenIds.current = null;
        setLoopReset((n) => n + 1);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "MaxLPS failed");
    }
  }, [rackId]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(id);
  }, [load, pollMs]);

  const refreshHop = useCallback(async () => {
    try {
      const next = await api.provisionHop();
      setHop(next);
      if (next.host) setHopHost(next.host);
      if (next.user) setHopUser(next.user);
      if (!next.connected && mayEdit && !hopAsked.current) {
        hopAsked.current = true;
        setHopOpen(true);
      }
    } catch {
      /* hop status is optional */
    }
  }, [mayEdit]);

  useEffect(() => {
    void refreshHop();
    const id = window.setInterval(() => void refreshHop(), 4000);
    return () => window.clearInterval(id);
  }, [refreshHop]);

  async function connectHop() {
    setHopBusy(true);
    try {
      const next = await api.provisionHopConnect({
        host: hopHost,
        username: hopUser,
        password: hopPass || undefined,
      });
      setHop(next);
      setHopPass("");
      setHopOpen(false);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "PXE hop failed");
    } finally {
      setHopBusy(false);
    }
  }



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
    view?.totals?.allowable_kw && view.totals.allowable_kw > 0
      ? view.totals.allowable_kw
      : availableKw * gpuFrac;
  const gpuLeftKw = gpuAvailKw - gpuUsedKw;
  const overheadKw = useMemo(
    () => (view?.racks ?? []).reduce((s, r) => s + (r.overhead_kw || 0), 0),
    [view?.racks],
  );
  const nRacks = view?.racks?.length ?? 0;
  const nGpus = totals?.gpu_live || totals?.gpus_listed || (view?.gpus ?? []).length;
  const gpuLive = view?.totals?.gpu_source === "redfish" && gpuUsedKw >= 0.05;
  const rackLive = view?.totals?.shelf_source === "argus" && rackUsedKw >= 0.05;
  const rackFlash = useOnceDelta(rackUsedKw, rackLive, 0.5);
  const gpuFlash = useOnceDelta(gpuUsedKw, gpuLive, 0.5);
  const rackDelta = rackFlash.delta;
  const gpuDelta = gpuFlash.delta;

  const sortedGpus = useMemo(() => {
    const src = view?.gpus ?? [];
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
  }, [view?.gpus, sortKey, sortDir, deltas]);

  const selectedGpu = (gpuId && sortedGpus.find((g) => g.id === gpuId)) || null;

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

  return (
    <div className="maxlps-page">
      <header className="maxlps-head">
        <div>
          <p className="maxlps-kicker">
            {power?.mode === "static" ? "Monitoring · GPUs at max cap" : "Closed-loop GPU power"}
          </p>
          <h1>MaxLPS</h1>
          <p>
            {topo
              ? `${topo.model} · ${topo.racks} racks · ${topo.nodes_per_rack} nodes/rack · ${topo.gpus_per_node} GPU/node · ${topo.gpu_count.toLocaleString()} GPU · TDP ${formatW(topo.gpu_tdp_w)}`
              : "GB300 NVL72"}
          </p>
        </div>
        <div className="lps-modes">
          <button
            type="button"
            data-active={hop?.connected ? "true" : undefined}
            disabled={!mayEdit || hopBusy}
            onClick={() => setHopOpen(true)}
            title={hop?.connected ? `PXE hop ${hop.host}` : "Connect PXE hop for GPU Redfish"}
          >
            {hop?.connected ? `Hop · ${hop.host}` : "Connect PXE hop"}
          </button>
          <button type="button" data-active={power?.mode === "static"} disabled={locked} onClick={() => setMode("static")}>
            Static
          </button>
          <button type="button" data-active={power?.mode === "dynamic"} disabled={locked} onClick={() => setMode("dynamic")}>
            MaxLPS
          </button>
          <button type="button" disabled={locked} onClick={() => setMode("dynamic", true)}>
            Replay
          </button>
        </div>
      </header>

      {error ? <p className="cluster-error">{error}</p> : null}
      {!hop?.connected ? (
        <p className="cluster-error maxlps-hop-ask">
          GPU watts need BMC Redfish through the PXE hop.
          {mayEdit ? (
            <>
              {" "}
              <button type="button" className="maxlps-hop-link" onClick={() => setHopOpen(true)}>
                Connect now
              </button>
            </>
          ) : (
            " Ask an editor to connect it."
          )}
        </p>
      ) : null}

      <section className="maxlps-stats">
        <article data-lead="true">
          <span>Total rack</span>
          <b>{formatRackKw(rackUsedKw)}</b>
          <small>
            {view?.totals?.shelf_source === "argus" ? "Argus TotalPowerOut" : "No PSU readings"}
          </small>
        </article>
        <article data-free={gpuLeftKw < 0 ? "over" : "ok"}>
          <span>GPU cap left</span>
          <b>{formatRackKw(Math.max(0, gpuLeftKw))}</b>
          <small>GPU share of envelope − live watts</small>
        </article>
        <article>
          <span>Rack sum</span>
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
            Σ {nRacks.toLocaleString()} racks
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
              : view?.totals?.gpu_error === "pxe-hop-down"
                ? "Connect the PXE hop for Redfish"
                : "No BMC Redfish readings yet"}
          </small>
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
              {view?.totals?.shelf_source === "argus"
                ? "Argus TotalPowerOut per shelf"
                : "Empty until Argus TotalPowerOut"}
              {view?.totals?.shelf_source === "argus" && view?.racks?.length ? ` · ${formatRackKw(rackUsedKw)} total` : ""}
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
              {view?.totals?.gpu_source === "redfish"
                ? `Redfish PowerWatts · ${view.totals.gpu_live ?? 0} GPU · ${
                    view.totals.gpu_busy && (view.totals.gpu_poll_age_s ?? 99) < 1
                      ? "polling"
                      : view.totals.gpu_poll_age_s == null
                        ? "waiting"
                        : view.totals.gpu_poll_age_s < 1.5
                          ? "live"
                          : `${Math.round(view.totals.gpu_poll_age_s)}s ago`
                  }`
                : hop?.connected
                  ? "Empty until BMC EnvironmentMetrics arrive"
                  : "Connect the PXE hop for GPU Redfish"}
              {view?.totals?.gpu_error ? ` · ${view.totals.gpu_error}` : ""}
              {" · green gain / red loss"}
            </p>
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
                tick={loopReset}
                wattTick={wattTick}
                onSelect={onSelectGpu}
              />
            ) : (
              <div className="maxlps-gpu-empty">
                <p>{hop?.connected ? "No GPU power readings yet" : "PXE hop is not connected"}</p>
                <span>
                  {hop?.connected
                    ? "MaxLPS only shows BMC EnvironmentMetrics. Wait for the next poll, or reopen hop if the jump dropped."
                    : "GPU bars stay empty until this API can SSH to the PXE host and read Redfish on 10.10.x."}
                </span>
                {!hop?.connected && mayEdit ? (
                  <button type="button" className="btn btn-primary" onClick={() => setHopOpen(true)}>
                    Connect PXE hop
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </section>

        <aside className="maxlps-loop">
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
                <p className="lps-event">MaxLPS off — caps restored to BMC AllowableMax. Redfish watts still update.</p>
              ) : null}
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
                {" · next in "}
                <EtaClock seconds={loopSec} resetKey={loopReset} />
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
                    ? `Click a GPU for process, curve, and per-GPU min/max · every ${view.algo.interval_s ?? 10}s`
                    : "Click a GPU to inspect it."}
                </p>
              )}
            </>
          )}
        </aside>
      </div>
      {hopOpen ? (
        <ThemeDialog
          title="PXE jump host"
          confirmLabel="Connect"
          busy={hopBusy}
          onClose={() => setHopOpen(false)}
          onConfirm={() => void connectHop()}
        >
          <p className="widget-meta" style={{ margin: "0 0 0.6rem" }}>
            MaxLPS reads GPU watts from BMC Redfish on 10.10.x. SSH to the PXE host first. Password stays in this API process only.
          </p>
          <label>
            PXE IP
            <input
              className="field"
              value={hopHost}
              onChange={(e) => setHopHost(e.target.value)}
              placeholder="172.25.231.244"
            />
          </label>
          <label>
            Username
            <input className="field" value={hopUser} onChange={(e) => setHopUser(e.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input
              className="field"
              type="password"
              value={hopPass}
              onChange={(e) => setHopPass(e.target.value)}
              autoComplete="current-password"
            />
          </label>
        </ThemeDialog>
      ) : null}
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

function EtaClock({ seconds, resetKey }: { seconds: number; resetKey: number }) {
  const [eta, setEta] = useState(seconds);
  useEffect(() => {
    setEta(seconds);
  }, [seconds, resetKey]);
  useEffect(() => {
    const id = window.setInterval(() => setEta((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [resetKey]);
  return <span>{eta}s</span>;
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
    if (prevOrder.current && prevOrder.current !== orderKey && prevTops.current.size) {
      playEntrySwap(rootRef.current, prevTops.current, { duration: SWAP_MS });
    }
    prevOrder.current = orderKey;
    prevTops.current = last;
  }, [orderKey]);

  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (let i = 0; i < gpus.length; i++) next.set(gpus[i].id, i);
    if (shuffle) {
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
  }, [gpus, shuffle, tick, start, end]);
  return (
    <div ref={rootRef} className="maxlps-gpu-virt" style={{ height: Math.max(gpus.length * ROW_H, viewH) }}>
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
  const pct = Math.min(100, (rack.shelf_kw / scale) * 100);
  const minPct = Math.min(100, (Math.max(0, minKw) / scale) * 100);
  const band =
    rack.shelf_kw > 0 && rack.shelf_kw < minKw - 0.05 ? "under" : rack.shelf_kw > maxKw + 0.05 ? "over" : "ok";
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
            title={`${formatRackKw(rack.shelf_kw)} · min ${formatKw(minKw)} · max ${formatKw(maxKw)}`}
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
            return (
              <li key={s.id}>
                <div className="maxlps-ps">
                  <span />
                  <span className="maxlps-shelf-id">PS{s.index}</span>
                  <span className="maxlps-shelf-bar" aria-hidden>
                    <i data-k="ps" style={{ width: `${Math.min(100, (s.kw / shelfCap) * 100)}%` }} />
                  </span>
                  <span className="maxlps-shelf-kw">{formatShelfKw(s.kw)}</span>
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

function LoopFields({
  intervalS,
  gpuPowerPct,
  desiredCapPct,
  gpuMinW,
  gpuMaxW,
  locked,
  onChange,
}: {
  intervalS: number;
  gpuPowerPct: number;
  desiredCapPct: number;
  gpuMinW: number;
  gpuMaxW: number;
  locked?: boolean;
  onChange: () => void;
}) {
  const [freq, setFreq] = useState(String(intervalS));
  const [gpuPct, setGpuPct] = useState(String(Math.round(gpuPowerPct)));
  const [capPct, setCapPct] = useState(String(Math.round(desiredCapPct)));
  const [minW, setMinW] = useState(String(Math.round(gpuMinW)));
  const [maxW, setMaxW] = useState(String(Math.round(gpuMaxW)));
  const editing = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (editing.current) return;
    if (String(intervalS) !== freq) setFreq(String(intervalS));
    const g = String(Math.round(gpuPowerPct));
    if (g !== gpuPct) setGpuPct(g);
    const c = String(Math.round(desiredCapPct));
    if (c !== capPct) setCapPct(c);
    const mn = String(Math.round(gpuMinW));
    if (mn !== minW) setMinW(mn);
    const mx = String(Math.round(gpuMaxW));
    if (mx !== maxW) setMaxW(mx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalS, gpuPowerPct, desiredCapPct, gpuMinW, gpuMaxW]);

  async function commit(nextFreq = freq, nextGpu = gpuPct, nextCap = capPct, nextMin = minW, nextMax = maxW) {
    const interval_s = Number(nextFreq);
    const gpu_power_percent = Number(nextGpu);
    const desired_cap_percent = Number(nextCap);
    const gpu_min_w = Number(nextMin);
    const gpu_max_w = Number(nextMax);
    if (![interval_s, gpu_power_percent, desired_cap_percent, gpu_min_w, gpu_max_w].every(Number.isFinite)) return;
    if (interval_s < 1 || interval_s > 300) return;
    if (gpu_power_percent < 10 || gpu_power_percent > 100) return;
    if (desired_cap_percent < 10 || desired_cap_percent > 100) return;
    if (gpu_min_w < 50 || gpu_max_w > 2000 || gpu_min_w > gpu_max_w) return;
    if (
      interval_s === intervalS &&
      gpu_power_percent === Math.round(gpuPowerPct) &&
      desired_cap_percent === Math.round(desiredCapPct) &&
      gpu_min_w === Math.round(gpuMinW) &&
      gpu_max_w === Math.round(gpuMaxW)
    ) {
      return;
    }
    try {
      await api.patchClusterPower({ interval_s, gpu_power_percent, desired_cap_percent, gpu_min_w, gpu_max_w });
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
        label="Frequency"
        tip="How often posted GPU caps are recalculated. Draw still updates every second; each interval uses average watts from that window."
      >
        <span className="lps-policy-pct">
          <input type="number" min={1} max={300} step={1} value={freq} aria-label="Control loop interval in seconds" {...bind(setFreq)} />
          s
        </span>
      </PolicyField>
      <PolicyField
        label="GPU power"
        tip="Share of available power (total × threshold) reserved for GPUs. Caps refit to this on the next frequency tick."
      >
        <span className="lps-policy-pct">
          <input
            type="number"
            min={10}
            max={100}
            step={1}
            value={gpuPct}
            aria-label="GPU share of available power"
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
  onSelect,
}: {
  gpu: MaxLpsGpu;
  delta?: number | "new";
  wattDelta: number;
  active?: boolean;
  tick: number;
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
      aria-label={`${rankLabel(gpu.rank)} ${gpu.serial || "gpu"} ${gpu.hostname || gpu.rack_label}`}
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
  }));
  const editing = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);

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
    });
  }, [gpu.id]);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
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
        });
      } catch {
        /* keep last window */
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
          <dd>
            {live.workload ?? gpu.workload ?? "—"}
            {(live.workloadKind ?? gpu.workload_kind) && (live.workloadKind ?? gpu.workload_kind) !== "idle"
              ? ` · ${live.workloadKind ?? gpu.workload_kind}`
              : ""}
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
