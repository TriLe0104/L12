"use client";

import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import type { FabricPort, FabricTopology, LiveTraffic } from "@/lib/cluster";
import { formatGbps } from "@/lib/cluster";

export type SelectedSwitch = { id: string; role: string; hallId?: string };

export function SwitchPanel({
  selected,
  onClose,
}: {
  selected: SelectedSwitch;
  onClose: () => void;
}) {
  const [topo, setTopo] = useState<FabricTopology | null>(null);
  const [live, setLive] = useState<LiveTraffic | null>(null);
  const [ports, setPorts] = useState<FabricPort[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const [t, l, p] = await Promise.all([
          api.fabric(),
          api.fabricLive(selected.id),
          api.fabricPorts({ q: selected.id }),
        ]);
        if (stop) return;
        setTopo(t);
        setLive(l);
        setPorts(p.ports.filter((row) => row.local_system === selected.id));
        setError(null);
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "Failed to load switch");
      }
    };
    load();
    const id = window.setInterval(load, 2000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [selected.id]);

  const node = topo?.nodes.find((n) => n.id === selected.id);
  const stats = live?.nodes[selected.id];
  const active = ports.filter((p) => p.state === "Active");
  const down = ports.filter((p) => p.state !== "Active");
  const cages = node?.ports ?? 64;
  const links = useMemo(
    () => (live?.links ?? []).filter((l) => l.from_id === selected.id || l.to_id === selected.id),
    [live, selected.id],
  );
  const role = node?.role ?? selected.role;
  const title = node?.label ?? selected.id;

  return (
    <aside className="rack-panel hall-panel switch-panel" aria-label="Switch details">
      <header className="rack-panel-head">
        <nav className="rack-panel-tabs">
          <button type="button" data-active="true">
            Switch
          </button>
        </nav>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="rack-panel-title">
        <strong>{title}</strong>
        <span>
          {selected.id} · {String(role).toUpperCase()} · Quantum-2
        </span>
      </div>
      {error && <p className="cluster-error">{error}</p>}
      <div className="switch-kpis">
        <div>
          <dt>Ports</dt>
          <dd>
            {active.length}/{cages}
            <small>active</small>
          </dd>
        </div>
        <div>
          <dt>Down</dt>
          <dd>{down.length}</dd>
        </div>
        <div>
          <dt>Tx</dt>
          <dd>{stats ? formatGbps(stats.tx_gbps) : "—"}</dd>
        </div>
        <div>
          <dt>Rx</dt>
          <dd>{stats ? formatGbps(stats.rx_gbps) : "—"}</dd>
        </div>
      </div>
      <div className="rack-usage" style={{ paddingTop: "0.35rem" }}>
        <div className="usage-meter">
          <div className="usage-meter-label">
            <span>Tx</span>
            <b>{stats ? formatGbps(stats.tx_gbps) : "—"}</b>
          </div>
          <div className="meter" aria-hidden>
            <i style={{ width: `${Math.min(100, stats ? (stats.tx_gbps / (800 * 8)) * 100 : 0)}%` }} />
          </div>
        </div>
        <div className="usage-meter">
          <div className="usage-meter-label">
            <span>Rx</span>
            <b>{stats ? formatGbps(stats.rx_gbps) : "—"}</b>
          </div>
          <div className="meter" aria-hidden>
            <i style={{ width: `${Math.min(100, stats ? (stats.rx_gbps / (800 * 8)) * 100 : 0)}%` }} />
          </div>
        </div>
        <p className="widget-meta" style={{ margin: "0.35rem 0.9rem 0.2rem" }}>
          {topo?.summary.speed ?? "800 Gbps"} · util {stats?.util_pct ?? 0}% · {links.length} live links
        </p>
      </div>
      <div className="health-table-wrap" style={{ maxHeight: "14rem" }}>
        <table className="network-table">
          <thead>
            <tr>
              <th>Port</th>
              <th>Peer</th>
              <th>State</th>
              <th>Tx / Rx</th>
            </tr>
          </thead>
          <tbody>
            {ports.slice(0, 48).map((p) => {
              const peer = p.peer_system;
              const hit = links.find((l) => {
                if (l.from_id === selected.id) return l.to_name === peer || l.to_id === peer;
                if (l.to_id === selected.id) return l.from_name === peer || l.from_id === peer;
                return false;
              });
              return (
                <tr key={`${p.local_port}-${p.peer_system}`} data-state={p.state}>
                  <td>
                    {p.physical_port ?? `QSFP-DD ${p.local_port}`}
                    <div className="port-sub">p{p.local_port}</div>
                  </td>
                  <td>{p.peer_system || "—"}</td>
                  <td className="port-state">{p.state}</td>
                  <td>
                    {p.state === "Active" && hit
                      ? `${formatGbps(hit.tx_gbps)} / ${formatGbps(hit.rx_gbps)}`
                      : p.state === "Active"
                        ? "live"
                        : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
