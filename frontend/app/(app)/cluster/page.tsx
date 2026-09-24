"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { OverviewDash } from "@/components/OverviewDash";
import { PowerPolicyFields, usePowerLimiter } from "@/components/PowerLimiter";
import { RackBoard } from "@/components/RackBoard";
import { RackPanel } from "@/components/RackPanel";
import { SwitchPanel, type SelectedSwitch } from "@/components/SwitchPanel";
import { ThemeDialog } from "@/components/ThemeDialog";
import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type { Campus, ClusterOverview, ClusterRack, HallDetail, Telemetry } from "@/lib/cluster";
import { formatKw } from "@/lib/cluster";
import type { ZoomLevel } from "@/components/ClusterCanvas";

import "./cluster.css";
import "./pod-power.css";
import "../network/network.css";

const ClusterCanvas = dynamic(
  () => import("@/components/ClusterCanvas").then((m) => m.ClusterCanvas),
  { ssr: false, loading: () => <div className="cluster-canvas cluster-canvas-pending">Loading floor…</div> },
);

type Tab = "overview" | "racks" | "floor";

export default function ClusterPage() {
  const { user } = useAuth();
  const mayEdit = canEdit(user);
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [campus, setCampus] = useState<Campus | null>(null);
  const [halls, setHalls] = useState<HallDetail[]>([]);
  const [hallId, setHallId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ level: ZoomLevel; hallId: string | null }>({ level: "hall", hallId: null });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hallOverview, setHallOverview] = useState(false);
  const [selectedNet, setSelectedNet] = useState<SelectedSwitch | null>(null);
  const [flyHallId, setFlyHallId] = useState<string | null>(null);
  const [rackTab, setRackTab] = useState<"overview" | "details">("overview");
  const [placeMode, setPlaceMode] = useState(false);
  const [pendingRackName, setPendingRackName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "hall" | "rack" | "delete-hall" | "delete-rack" | "delete-bulk">(null);
  const [hallName, setHallName] = useState("");
  const [hallW, setHallW] = useState(18);
  const [hallD, setHallD] = useState(10);
  const [rackName, setRackName] = useState("");
  const [matrixCols, setMatrixCols] = useState(16);
  const [matrixRows, setMatrixRows] = useState(4);
  const [matrixCount, setMatrixCount] = useState(64);
  const [rackPrefix, setRackPrefix] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [clusterName, setClusterName] = useState("Firmus");

  const { data: power, setData: setPower, byId: powerByRack } = usePowerLimiter(tab === "floor" || tab === "racks");
  const inventoryCampus = campus?.source === "inventory";

  const hall = halls.find((h) => h.id === hallId) ?? null;
  const selectedRacks = halls.flatMap((h) => h.racks).filter((r) => selectedIds.includes(r.id));
  const selected = selectedRacks.length === 1 ? selectedRacks[0] : null;
  const overviewHall = hallOverview ? (halls.find((h) => h.id === hallId) ?? null) : null;
  const hudHall = halls.find((h) => h.id === (zoom.hallId ?? hallId)) ?? hall;
  const hudTelemetry: Telemetry | undefined =
    zoom.level === "cluster" ? campus?.telemetry : hudHall?.telemetry;

  const loadOverview = useCallback(async () => {
    const next = await api.clusterOverview();
    setOverview(next);
    if (next.name) setClusterName(next.name);
  }, []);

  const loadHalls = useCallback(async () => {
    const campusData = await api.campus();
    setCampus(campusData);
    if (campusData.name) setClusterName(campusData.name);
    setHalls(campusData.halls);
    setHallId((current) => current ?? campusData.halls[0]?.id ?? null);
    return campusData.halls;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await Promise.all([loadOverview(), loadHalls()]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load cluster");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadHalls, loadOverview]);

  useEffect(() => {
    if (tab !== "racks" && tab !== "floor") return;
    const id = window.setInterval(() => {
      loadHalls().catch(() => {
        /* keep last campus */
      });
    }, 2000);
    return () => window.clearInterval(id);
  }, [tab, loadHalls]);

  function replaceRack(updated: ClusterRack) {
    const patch = (list: HallDetail[]) =>
      list.map((h) =>
        h.id !== updated.hall_id
          ? h
          : { ...h, racks: h.racks.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)) },
      );
    setHalls(patch);
    setCampus((c) => (c ? { ...c, halls: patch(c.halls) } : c));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (dialog) return;
      if (placeMode) {
        setPlaceMode(false);
        return;
      }
      if (selectedIds.length) {
        setSelectedIds([]);
        return;
      }
      if (selectedNet) {
        setSelectedNet(null);
        return;
      }
      setHallOverview(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, placeMode, selectedIds.length, selectedNet]);

  async function refreshAll() {
    await Promise.all([loadOverview(), loadHalls()]);
  }

  function defaultHallName() {
    return `Hall ${String.fromCharCode(65 + halls.length)}`;
  }

  function defaultRackName() {
    if (!hall) return "rack-01";
    const n = hall.racks.length + 1;
    const slug = hall.name.split(" ")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
    return `${slug || "rack"}-r${String(n).padStart(2, "0")}`;
  }

  function openHallDialog() {
    setHallName(defaultHallName());
    setHallW(18);
    setHallD(10);
    setDialog("hall");
  }

  function openRackDialog() {
    if (!hall) return;
    setRackName(defaultRackName());
    setMatrixCols(16);
    setMatrixRows(4);
    setMatrixCount(64);
    setRackPrefix(hall.name);
    setTab("floor");
    setDialog("rack");
  }

  async function confirmHall() {
    const name = hallName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createHall({
        name,
        width_tiles: hallW,
        depth_tiles: hallD,
      });
      setDialog(null);
      await loadHalls();
      setHallId(created.id);
      setTab("floor");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create hall");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteHall() {
    if (!hall) return;
    setBusy(true);
    try {
      await api.deleteHall(hall.id);
      setDialog(null);
      setSelectedIds([]);
      const list = await loadHalls();
      setHallId(list[0]?.id ?? null);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete hall");
    } finally {
      setBusy(false);
    }
  }

  function confirmRackName() {
    const name = rackName.trim();
    if (!name) return;
    setPendingRackName(name);
    setDialog(null);
    setPlaceMode(true);
    setTab("floor");
  }

  async function confirmAddRacks() {
    if (!hall) return;
    const cols = Math.max(1, matrixCols);
    const rows = Math.max(1, matrixRows);
    const count = Math.max(1, Math.min(matrixCount, cols * rows));
    setBusy(true);
    setError(null);
    try {
      await api.createRacksBulk(hall.id, {
        cols,
        rows,
        count,
        prefix: rackPrefix.trim() || hall.name,
        aisle: true,
      });
      setDialog(null);
      await loadHalls();
      await loadOverview();
      setTab("floor");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add racks");
    } finally {
      setBusy(false);
    }
  }

  async function onPlace(targetHallId: string, x: number, y: number) {
    const name = pendingRackName.trim() || defaultRackName();
    setBusy(true);
    setError(null);
    try {
      const rack = await api.createRack(targetHallId, { name, x, y });
      setPlaceMode(false);
      setPendingRackName("");
      await loadHalls();
      await loadOverview();
      setHallId(hallId);
      setSelectedIds([rack.id]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not place rack");
    } finally {
      setBusy(false);
    }
  }

  async function onMove(id: string, x: number, y: number) {
    try {
      replaceRack(await api.updateRack(id, { x, y }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move rack");
      await loadHalls();
    }
  }

  async function onRotate(rack: ClusterRack) {
    replaceRack(await api.updateRack(rack.id, { rotation: (rack.rotation + 90) % 360 }));
  }

  async function onRename(rack: ClusterRack, name: string) {
    replaceRack(await api.updateRack(rack.id, { name }));
  }

  async function onDeleteRack() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.deleteRack(selected.id);
      setDialog(null);
      setSelectedIds([]);
      await loadHalls();
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete rack");
    } finally {
      setBusy(false);
    }
  }

  async function patchSelected(payload: { power_state?: string; run_status?: string }) {
    if (!selected) return;
    setBusy(true);
    try {
      replaceRack(await api.updateRack(selected.id, payload));
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update rack");
      await loadHalls();
    } finally {
      setBusy(false);
    }
  }

  async function bulkPatch(
    payload: { power_state?: string; run_status?: string; delete?: boolean },
    ids = selectedIds,
  ) {
    if (!ids.length) return;
    setBusy(true);
    try {
      await api.patchRacksBulk({ ids, ...payload });
      if (payload.delete) setSelectedIds([]);
      await loadHalls();
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk update failed");
      await loadHalls();
    } finally {
      setBusy(false);
    }
  }

  async function onRestart(rack: ClusterRack) {
    setRestarting(true);
    setBusy(true);
    try {
      replaceRack(await api.updateRack(rack.id, { power_state: "on", run_status: "running" }));
      await new Promise((resolve) => setTimeout(resolve, 1600));
      replaceRack(await api.updateRack(rack.id, { run_status: "ready" }));
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restart failed");
    } finally {
      setBusy(false);
      setRestarting(false);
    }
  }

  return (
    <div className="cluster-app">
      <div className="cluster-toolbar">
        <div className="cluster-tabs">
          {mayEdit ? (
            <input
              className="cluster-kicker cluster-kicker-input"
              value={clusterName}
              aria-label="Cluster name"
              title="Cluster name"
              onChange={(e) => setClusterName(e.target.value)}
              onBlur={async () => {
                const next = clusterName.trim();
                if (!next || next === (campus?.name ?? overview?.name)) return;
                try {
                  const saved = await api.patchClusterName(next);
                  setClusterName(saved.name);
                  setCampus((cur) => (cur ? { ...cur, name: saved.name } : cur));
                  setOverview((cur) => (cur ? { ...cur, name: saved.name } : cur));
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not rename cluster");
                  setClusterName(campus?.name ?? overview?.name ?? "Firmus");
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          ) : (
            <span className="cluster-kicker">{clusterName || campus?.name || overview?.name || "Firmus"}</span>
          )}
          <button type="button" data-active={tab === "overview"} onClick={() => setTab("overview")}>
            Overview
          </button>
          <button type="button" data-active={tab === "racks"} onClick={() => setTab("racks")}>
            Racks
          </button>
          <button
            type="button"
            data-active={tab === "floor"}
            onClick={() => {
              setTab("floor");
              setFlyHallId(null);
              setHallOverview(false);
            }}
          >
            Floor
          </button>
        </div>
        <div className="cluster-tools">
          {tab === "floor" && (
            <>
              <select
                className="field"
                value={hallId ?? ""}
                onChange={(e) => {
                  setSelectedIds([]);
                  setHallId(e.target.value || null);
                  setFlyHallId(e.target.value || null);
                  setHallOverview(true);
                }}
                aria-label="Data hall"
              >
                {halls.length === 0 && <option value="">No data halls</option>}
                {halls.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} · {h.rack_count} racks
                  </option>
                ))}
              </select>
              {mayEdit && !inventoryCampus && (
                <>
                  <button type="button" className="btn" onClick={openHallDialog} disabled={busy}>
                    New hall
                  </button>
                  <button type="button" className="btn" onClick={openRackDialog} disabled={busy || !hall} data-active={placeMode}>
                    {placeMode ? "Click floor…" : "Add racks"}
                  </button>
                  {hall && (
                    <button type="button" className="btn btn-danger" onClick={() => setDialog("delete-hall")} disabled={busy}>
                      Delete hall
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="cluster-error">
          {error}{" "}
          <button type="button" className="btn" onClick={() => { setError(null); refreshAll(); }}>
            Retry
          </button>
        </p>
      )}

      {tab === "overview" && (
        <section className="cluster-overview">
          <OverviewDash halls={halls} />
        </section>
      )}

      {tab === "racks" && <RackBoard halls={halls} />}

      {tab === "floor" && (
        <section className="cluster-floor">
          <div className="cluster-floor-stage">
          {halls.length > 0 ? (
            <ClusterCanvas
              halls={halls}
              clusterName={clusterName}
              selectedIds={selectedIds}
              focusHallId={flyHallId}
              placeMode={placeMode}
              canEdit={mayEdit && !inventoryCampus}
              powerByRack={powerByRack}
              onSelect={(id, opts) => {
                setPlaceMode(false);
                setHallOverview(false);
                setSelectedNet(null);
                if (!id) {
                  setSelectedIds([]);
                  return;
                }
                setSelectedIds((cur) => {
                  if (opts?.additive) return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
                  return [id];
                });
                setRackTab("overview");
              }}
              onMove={onMove}
              onPlace={onPlace}
              onViewChange={(v) => setZoom({ level: v.level, hallId: v.hallId })}
              onFocusHall={(id) => {
                setHallId(id);
                setFlyHallId(id);
                setSelectedIds([]);
                setSelectedNet(null);
                setHallOverview(true);
              }}
              onSelectNet={(sel) => {
                setSelectedIds([]);
                setHallOverview(false);
                setSelectedNet(sel);
              }}
            />
          ) : (
            <div className="cluster-canvas cluster-canvas-pending">
              {inventoryCampus
                ? "Register a rack in Dynamic Power to see it on the floor."
                : mayEdit
                  ? "Create a data hall to start laying out racks."
                  : "No data halls yet."}
            </div>
          )}
          {power && (
            <aside className="lps-hud" aria-label="Power limiter">
              <div className="lps-hud-kicker">{power.mode === "dynamic" ? "Dynamic Power" : "Static"}</div>
              <strong>{formatKw(power.active.consumed_kw)}</strong>
              <span className="lps-hud-sub">
                {formatKw(power.total_budget_kw ?? power.budget_kw)} × {Math.round(power.threshold_pct ?? power.stay_under_pct ?? 80)}% · static {power.racks_static_max ?? 0} · Dynamic Power {power.racks_lps_max ?? 0}{power.racks_lps_gain ? ` (+${power.racks_lps_gain})` : ""} · [{Math.round(power.min_rack_kw ?? 40)}–{Math.round(power.max_rack_kw ?? 300)}] kW
              </span>
              <dl>
                <div>
                  <dt>Stranded</dt>
                  <dd>{formatKw(power.active.stranded_kw)}</dd>
                </div>
                <div>
                  <dt>Hot racks</dt>
                  <dd>{power.active.racks_hot ?? 0}</dd>
                </div>
                <div>
                  <dt>Headroom</dt>
                  <dd>{formatKw(power.active.headroom_kw)}</dd>
                </div>
                <div>
                  <dt>Tick</dt>
                  <dd>{power.tick}</dd>
                </div>
              </dl>
              <PowerPolicyFields data={power} onChange={setPower} compact />
              <div className="lps-hud-modes">
                <button
                  type="button"
                  data-active={power.mode === "static"}
                  onClick={() => api.patchClusterPower({ mode: "static" }).then(setPower)}
                >
                  Static
                </button>
                <button
                  type="button"
                  data-active={power.mode === "dynamic"}
                  onClick={() => api.patchClusterPower({ mode: "dynamic" }).then(setPower)}
                >
                  Dynamic Power
                </button>
                <button type="button" onClick={() => api.patchClusterPower({ mode: "dynamic", reset: true }).then(setPower)}>
                  Replay
                </button>
              </div>
            </aside>
          )}
          {hudTelemetry && (
            <aside className="zoom-hud" data-level={zoom.level}>
              <div className="zoom-hud-kicker">
                {zoom.level === "cluster"
                  ? clusterName || campus?.name || "Firmus"
                  : zoom.level === "hall"
                    ? hudHall?.name ?? "Data hall"
                    : hall?.name ?? "Rack"}
              </div>
              <strong>{formatKw(hudTelemetry.power_kw)}</strong>
              <span className="zoom-hud-sub">
                {hudTelemetry.racks_on}/{hudTelemetry.racks_total} racks · {(hudTelemetry.racks_total * 18).toLocaleString()} nodes
              </span>
              <dl>
                <div>
                  <dt>GPU</dt>
                  <dd>{Math.round(hudTelemetry.gpu_pct)}%</dd>
                </div>
                <div>
                  <dt>CPU</dt>
                  <dd>{Math.round(hudTelemetry.cpu_pct)}%</dd>
                </div>
                <div>
                  <dt>Mem</dt>
                  <dd>{Math.round(hudTelemetry.mem_pct)}%</dd>
                </div>
              </dl>
              <em className="zoom-hud-hint">
                {zoom.level === "cluster"
                  ? "Click a hall or a switch · 18 nodes · 4 GB300"
                  : zoom.level === "hall"
                    ? "Click a leaf/spine for ports · Ctrl+click racks"
                    : "Click switches for traffic · Ctrl+click racks"}
              </em>
            </aside>
          )}
          {halls.length > 0 && (
            <div className="net-legend-3d">
              <span>
                <i /> Spine
              </span>
              <span>
                <i data-k="leaf" /> Leaf
              </span>
              <span>
                <i data-k="up" /> Uplink 800G
              </span>
              <span>
                <i data-k="dn" /> Downlink
              </span>
              <span>
                <i data-k="used" /> Consumed
              </span>
              <span>
                <i data-k="spare" /> Unused alloc
              </span>
            </div>
          )}
          {placeMode && (
            <div className="place-hint">
              Place <b>{pendingRackName || "rack"}</b> — click an empty tile · Esc to cancel
            </div>
          )}
          {selectedRacks.length > 1 && (
            <div className="bulk-bar">
              <b>{selectedRacks.length} racks</b>
              <span>Ctrl+click to add · Esc to clear</span>
              {mayEdit && (
                <>
                  <button type="button" className="btn" disabled={busy} onClick={() => bulkPatch({ power_state: "on" })}>
                    Power on
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => bulkPatch({ power_state: "off" })}>
                    Power off
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => bulkPatch({ run_status: "running" })}>
                    Running
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => bulkPatch({ run_status: "idle" })}>
                    Idle
                  </button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setDialog("delete-bulk")}>
                    Delete
                  </button>
                </>
              )}
              <button type="button" className="btn" onClick={() => setSelectedIds([])}>
                Clear
              </button>
            </div>
          )}
          </div>
          {selectedNet && (
            <SwitchPanel selected={selectedNet} onClose={() => setSelectedNet(null)} />
          )}
          {overviewHall && selectedRacks.length === 0 && !selectedNet && (
            <aside className="rack-panel hall-panel" aria-label="Hall overview">
              <header className="rack-panel-head">
                <nav className="rack-panel-tabs">
                  <button type="button" data-active="true">
                    Hall Overview
                  </button>
                </nav>
                <button type="button" className="icon-btn" onClick={() => setHallOverview(false)} aria-label="Close">
                  ×
                </button>
              </header>
              <div className="rack-panel-title">
                <strong>{overviewHall.name}</strong>
                <span>{overviewHall.racks.length} racks · 18 nodes · 4 GB300</span>
              </div>
              {overviewHall.telemetry && (
                <div className="rack-usage">
                  <div className="usage-meter">
                    <div className="usage-meter-label">
                      <span>GPU</span>
                      <b>{Math.round(overviewHall.telemetry.gpu_pct)}%</b>
                    </div>
                    <div className="meter" aria-hidden>
                      <i style={{ width: `${overviewHall.telemetry.gpu_pct}%` }} />
                    </div>
                  </div>
                  <div className="usage-meter">
                    <div className="usage-meter-label">
                      <span>CPU</span>
                      <b>{Math.round(overviewHall.telemetry.cpu_pct)}%</b>
                    </div>
                    <div className="meter" aria-hidden>
                      <i style={{ width: `${overviewHall.telemetry.cpu_pct}%` }} />
                    </div>
                  </div>
                  <div className="usage-meter">
                    <div className="usage-meter-label">
                      <span>Mem</span>
                      <b>{Math.round(overviewHall.telemetry.mem_pct)}%</b>
                    </div>
                    <div className="meter" aria-hidden>
                      <i style={{ width: `${overviewHall.telemetry.mem_pct}%` }} />
                    </div>
                  </div>
                  <p className="widget-meta" style={{ margin: "0.4rem 0.9rem 0.2rem" }}>
                    {formatKw(overviewHall.telemetry.power_kw)} · {overviewHall.telemetry.racks_on}/{overviewHall.telemetry.racks_total} on
                  </p>
                </div>
              )}
              {mayEdit && (
                <div className="rack-actions" style={{ padding: "0.6rem 0.9rem 1rem", display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setSelectedIds(overviewHall.racks.map((r) => r.id));
                      setHallOverview(false);
                    }}
                  >
                    Select all racks
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => bulkPatch({ power_state: "on" }, overviewHall.racks.map((r) => r.id))}
                  >
                    Power all on
                  </button>
                </div>
              )}
            </aside>
          )}
          {selected && (
            <RackPanel
              rack={selected}
              tab={rackTab}
              onTab={setRackTab}
              canEdit={mayEdit && !inventoryCampus}
              busy={busy || restarting}
              power={powerByRack[selected.id]}
              onClose={() => setSelectedIds([])}
              onRotate={() => onRotate(selected)}
              onRename={(name) => onRename(selected, name)}
              onDelete={() => setDialog("delete-rack")}
              onPower={(state) => patchSelected({ power_state: state })}
              onRestart={() => onRestart(selected)}
            />
          )}
        </section>
      )}

      {dialog === "hall" && (
        <ThemeDialog
          title="New data hall"
          confirmLabel="Create hall"
          busy={busy}
          onConfirm={confirmHall}
          onClose={() => setDialog(null)}
        >
          <label>
            Name
            <input className="field" value={hallName} onChange={(e) => setHallName(e.target.value)} autoFocus />
          </label>
          <div className="theme-dialog-row">
            <label>
              Width
              <input
                className="field"
                type="number"
                min={4}
                max={64}
                value={hallW}
                onChange={(e) => setHallW(Number(e.target.value))}
              />
            </label>
            <label>
              Depth
              <input
                className="field"
                type="number"
                min={4}
                max={64}
                value={hallD}
                onChange={(e) => setHallD(Number(e.target.value))}
              />
            </label>
          </div>
          <p className="theme-dialog-hint">18×10 tiles fits a Firmus 16×4 rack row.</p>
        </ThemeDialog>
      )}

      {dialog === "rack" && (
        <ThemeDialog
          title="Add racks"
          confirmLabel={`Place ${Math.max(1, Math.min(matrixCount, matrixCols * matrixRows))} racks`}
          busy={busy}
          onConfirm={confirmAddRacks}
          onClose={() => setDialog(null)}
        >
          <label>
            Name prefix
            <input className="field" value={rackPrefix} onChange={(e) => setRackPrefix(e.target.value)} autoFocus />
          </label>
          <div className="theme-dialog-row">
            <label>
              Columns
              <input
                className="field"
                type="number"
                min={1}
                max={32}
                value={matrixCols}
                onChange={(e) => {
                  const cols = Number(e.target.value);
                  setMatrixCols(cols);
                  setMatrixCount(cols * matrixRows);
                }}
              />
            </label>
            <label>
              Rows
              <input
                className="field"
                type="number"
                min={1}
                max={32}
                value={matrixRows}
                onChange={(e) => {
                  const rows = Number(e.target.value);
                  setMatrixRows(rows);
                  setMatrixCount(matrixCols * rows);
                }}
              />
            </label>
            <label>
              Racks
              <input
                className="field"
                type="number"
                min={1}
                max={matrixCols * matrixRows}
                value={matrixCount}
                onChange={(e) => setMatrixCount(Number(e.target.value))}
              />
            </label>
          </div>
          <p className="theme-dialog-hint">
            Firmus default is 16×4 (64 racks) with a cold aisle between rows. Names become {rackPrefix || "HALL"}-R01C01…
          </p>
          <button type="button" className="btn" onClick={confirmRackName} disabled={busy || !rackName.trim()}>
            Place a single rack instead
          </button>
        </ThemeDialog>
      )}

      {dialog === "delete-hall" && hall && (
        <ThemeDialog
          title="Delete data hall"
          confirmLabel="Delete hall"
          danger
          busy={busy}
          onConfirm={confirmDeleteHall}
          onClose={() => setDialog(null)}
        >
          <p>
            Delete <b>{hall.name}</b> and every rack in it? This cannot be undone.
          </p>
        </ThemeDialog>
      )}

      {dialog === "delete-bulk" && (
        <ThemeDialog
          title="Delete racks"
          confirmLabel={`Delete ${selectedIds.length}`}
          danger
          busy={busy}
          onConfirm={async () => {
            await bulkPatch({ delete: true });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        >
          <p>
            Remove <b>{selectedIds.length}</b> selected racks from the floor?
          </p>
        </ThemeDialog>
      )}

      {dialog === "delete-rack" && selected && (
        <ThemeDialog
          title="Delete rack"
          confirmLabel="Delete rack"
          danger
          busy={busy}
          onConfirm={onDeleteRack}
          onClose={() => setDialog(null)}
        >
          <p>
            Remove <b>{selected.name}</b> from the floor?
          </p>
        </ThemeDialog>
      )}
    </div>
  );
}
