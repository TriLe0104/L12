"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import type { FabricNode, FabricPort, FabricTopology, LiveLink, LiveTraffic } from "@/lib/cluster";
import { formatGbps } from "@/lib/cluster";

import "../cluster/cluster.css";
import "./network.css";

type Tab = "map" | "ports" | "traffic";

type Box = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub: string;
  role: string;
};

function center(b: Box) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function utilWidth(gbps: number, cap = 800) {
  return `${Math.max(2, Math.min(100, (gbps / cap) * 100))}%`;
}

function PortFaceplate({
  system,
  ports,
  onPick,
  picked,
}: {
  system: string;
  ports: FabricPort[];
  onPick: (port: string) => void;
  picked: string;
}) {
  const byPort = new Map(ports.filter((p) => p.local_system === system).map((p) => [p.local_port, p]));
  const cages = Array.from({ length: 64 }, (_, i) => String(i + 1));
  return (
    <div className="faceplate">
      <div className="faceplate-head">
        <b>{system}</b>
        <span>Quantum-2 · 64 × QSFP-DD</span>
      </div>
      <div className="faceplate-grid">
        {cages.map((n) => {
          const p = byPort.get(n);
          const state = p?.state ?? "Down";
          return (
            <button
              type="button"
              key={n}
              className="cage"
              data-state={state}
              data-sel={picked === n ? "true" : "false"}
              title={p ? `${p.physical_port ?? `QSFP-DD ${n}`} → ${p.peer_system || "empty"}` : `QSFP-DD ${n} empty`}
              onClick={() => onPick(n)}
            >
              {n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TrafficBars({ tx, rx, cap = 800 }: { tx: number; rx: number; cap?: number }) {
  return (
    <div className="traffic-block">
      <h3>Live traffic</h3>
      <div className="tbar">
        <div className="tbar-head">
          <span>Tx</span>
          <b>{formatGbps(tx)}</b>
        </div>
        <div className="tbar-track">
          <i style={{ width: utilWidth(tx, cap) }} />
        </div>
      </div>
      <div className="tbar">
        <div className="tbar-head">
          <span>Rx</span>
          <b>{formatGbps(rx)}</b>
        </div>
        <div className="tbar-track">
          <i style={{ width: utilWidth(rx, cap) }} />
        </div>
      </div>
    </div>
  );
}

function FabricMap({
  topo,
  live,
  hallFilter,
  selectedId,
  onSelect,
}: {
  topo: FabricTopology;
  live: LiveTraffic | null;
  hallFilter: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const hot = useMemo(() => new Set((live?.links ?? []).slice(0, 12).map((l) => l.id)), [live]);
  const layout = useMemo(() => {
    const spines = topo.nodes.filter((n) => n.role === "spine");
    const leaves = topo.nodes.filter(
      (n) => n.role === "leaf" && (!hallFilter || n.hall_name === hallFilter),
    );
    const halls = [...new Set(leaves.map((n) => n.hall_name).filter(Boolean))] as string[];
    const W = 1280;
    const boxes: Box[] = [];
    const spineW = 86;
    const gap = spines.length > 1 ? (W - 120 - spineW) / (spines.length - 1) : 0;
    spines.forEach((n, i) => {
      boxes.push({
        id: n.id,
        x: 60 + i * gap,
        y: 48,
        w: spineW,
        h: 42,
        label: n.name,
        sub: "Q2 spine",
        role: "spine",
      });
    });
    const colW = W / Math.max(halls.length, 1);
    const cols = hallFilter ? 4 : 2;
    leaves.forEach((n) => {
      const hi = Math.max(0, halls.indexOf(n.hall_name ?? ""));
      const rowLeaves = leaves.filter((l) => l.hall_name === n.hall_name);
      const ri = rowLeaves.findIndex((l) => l.id === n.id);
      const col = ri % cols;
      const row = Math.floor(ri / cols);
      const cellW = hallFilter ? 140 : 128;
      boxes.push({
        id: n.id,
        x: hi * colW + 28 + col * cellW,
        y: 168 + row * 54,
        w: hallFilter ? 124 : 112,
        h: 40,
        label: n.name.replace(`${n.hall_name}-`, ""),
        sub: n.hall_name ?? "leaf",
        role: "leaf",
      });
    });
    const selected = topo.nodes.find((n) => n.id === selectedId);
    const rackNodes = topo.nodes.filter((n) => {
      if (n.role !== "rack") return false;
      if (selected?.role === "leaf") return n.hall_name === selected.hall_name && n.row === selected.row;
      if (hallFilter) return n.hall_name === hallFilter && selected?.role === "rack" && n.row === selected.row;
      return false;
    });
    rackNodes.forEach((n, i) => {
      const count = Math.max(rackNodes.length, 1);
      const w = 92;
      const total = count * (w + 10) - 10;
      const x0 = (W - total) / 2;
      boxes.push({
        id: n.id,
        x: x0 + i * (w + 10),
        y: 430,
        w,
        h: 36,
        label: n.name,
        sub: "HCA",
        role: "rack",
      });
    });
    const byId = new Map(boxes.map((b) => [b.id, b]));
    const links = topo.links.filter((l) => byId.has(l.from_id) && byId.has(l.to_id));
    return { boxes, byId, links, halls, W, hasRacks: rackNodes.length > 0 };
  }, [topo, hallFilter, selectedId]);

  return (
    <div className="network-map-canvas">
      <svg viewBox={`0 0 ${layout.W} ${layout.hasRacks ? 500 : 420}`} role="img" aria-label="Spine-leaf fabric map">
        <text className="nmap-label" x={layout.W / 2} y={24}>
          SPINE LAYER · {topo.summary.spines}× QUANTUM-2
        </text>
        {layout.halls.map((h, i) => {
          const colW = layout.W / layout.halls.length;
          return (
            <text key={h} className="nmap-hall" x={i * colW + 28} y={148}>
              {h}
            </text>
          );
        })}
        {layout.hasRacks && (
          <text className="nmap-label" x={layout.W / 2} y={414}>
            HOSTS
          </text>
        )}
        {layout.links.map((l) => {
          const a = layout.byId.get(l.from_id)!;
          const b = layout.byId.get(l.to_id)!;
          const ac = center(a);
          const bc = center(b);
          const sel = selectedId === l.from_id || selectedId === l.to_id;
          const d =
            l.role === "uplink"
              ? `M ${ac.x} ${a.y} C ${ac.x} ${a.y - 36}, ${bc.x} ${b.y + b.h + 36}, ${bc.x} ${b.y + b.h}`
              : `M ${ac.x} ${a.y + a.h} C ${ac.x} ${a.y + a.h + 28}, ${bc.x} ${b.y - 28}, ${bc.x} ${b.y}`;
          return (
            <path
              key={l.id}
              className="nmap-link"
              d={d}
              data-role={l.role}
              data-hot={hot.has(l.id) ? "true" : "false"}
              data-sel={sel ? "true" : "false"}
            />
          );
        })}
        {layout.boxes.map((box) => (
          <g
            key={box.id}
            className="nmap-node"
            data-role={box.role}
            data-selected={box.id === selectedId ? "true" : "false"}
            transform={`translate(${box.x} ${box.y})`}
            onClick={() => onSelect(box.id)}
          >
            <rect width={box.w} height={box.h} rx={2} />
            <text x={box.w / 2} y={box.h / 2 - 2}>
              {box.label}
            </text>
            <text className="sub" x={box.w / 2} y={box.h / 2 + 12}>
              {box.sub}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default function NetworkPage() {
  const [tab, setTab] = useState<Tab>("map");
  const [topo, setTopo] = useState<FabricTopology | null>(null);
  const [live, setLive] = useState<LiveTraffic | null>(null);
  const [ports, setPorts] = useState<FabricPort[]>([]);
  const [portCount, setPortCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hallFilter, setHallFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [query, setQuery] = useState("");
  const [switchId, setSwitchId] = useState("");
  const [cage, setCage] = useState("");
  const [history, setHistory] = useState<number[]>([]);

  const loadTopo = useCallback(async () => {
    const data = await api.fabric();
    setTopo(data);
    setSelectedId((cur) => cur ?? data.nodes.find((n) => n.role === "spine")?.id ?? null);
  }, []);

  const loadLive = useCallback(async () => {
    const data = await api.fabricLive();
    setLive(data);
    setHistory((prev) => [...prev.slice(-39), data.total_tx_gbps]);
  }, []);

  const loadPorts = useCallback(async () => {
    const data = await api.fabricPorts({
      hall: hallFilter || undefined,
      role: roleFilter || undefined,
      state: stateFilter || undefined,
      q: query.trim() || undefined,
    });
    setPorts(data.ports);
    setPortCount(data.count);
  }, [hallFilter, roleFilter, stateFilter, query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await Promise.all([loadTopo(), loadLive()]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load fabric");
      }
    })();
    const id = window.setInterval(() => {
      loadLive().catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [loadLive, loadTopo]);

  useEffect(() => {
    if (tab !== "ports") return;
    loadPorts().catch((err) => setError(err instanceof Error ? err.message : "Failed to load ports"));
  }, [tab, loadPorts]);

  const halls = useMemo(() => {
    const names = new Set<string>();
    for (const n of topo?.nodes ?? []) if (n.hall_name) names.add(n.hall_name);
    return [...names];
  }, [topo]);

  const selected: FabricNode | undefined = topo?.nodes.find((n) => n.id === selectedId);
  const selectedLive = selected ? live?.nodes[selected.id] : undefined;
  const selectedLinks = useMemo(() => {
    if (!topo || !selected) return [];
    return topo.links.filter((l) => l.from_id === selected.id || l.to_id === selected.id);
  }, [topo, selected]);

  const spark = useMemo(() => {
    if (history.length < 2) return null;
    const max = Math.max(...history, 1);
    const w = 120;
    const h = 36;
    const pts = history.map((v, i) => {
      const x = (i / (history.length - 1)) * w;
      const y = h - (v / max) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { line: pts.join(" "), area: `0,${h} ${pts.join(" ")} ${w},${h}` };
  }, [history]);

  const hottest = live?.links ?? [];
  const switchNames = useMemo(() => {
    const names = (topo?.nodes ?? []).filter((n) => n.role === "spine" || n.role === "leaf").map((n) => n.id);
    return names;
  }, [topo]);

  useEffect(() => {
    if (!switchId && switchNames[0]) setSwitchId(switchNames[0]);
  }, [switchId, switchNames]);
  const spineNodes = topo?.nodes.filter((n) => n.role === "spine") ?? [];

  return (
    <div className="cluster-app network-app">
      <div className="cluster-toolbar">
        <div className="cluster-tabs">
          <span className="cluster-kicker">Network</span>
          <button type="button" data-active={tab === "map"} onClick={() => setTab("map")}>
            Map
          </button>
          <button type="button" data-active={tab === "ports"} onClick={() => setTab("ports")}>
            Port Mapping
          </button>
          <button type="button" data-active={tab === "traffic"} onClick={() => setTab("traffic")}>
            Live Traffic
          </button>
        </div>
        <div className="cluster-tools">
          {live && (
            <span className="network-live-pill">
              <i />
              {live.active_links} active · {formatGbps(live.total_tx_gbps)} Tx
            </span>
          )}
          <select
            className="field"
            value={hallFilter}
            onChange={(e) => setHallFilter(e.target.value)}
            aria-label="Filter hall"
          >
            <option value="">All halls</option>
            {halls.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            onClick={() => {
              loadTopo().catch((err) => setError(err instanceof Error ? err.message : "Refresh failed"));
              loadLive().catch(() => undefined);
              if (tab === "ports") loadPorts().catch(() => undefined);
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <p className="cluster-error">
          {error}{" "}
          <button type="button" className="btn" onClick={() => { setError(null); loadTopo(); }}>
            Retry
          </button>
        </p>
      )}

      {tab === "map" && !topo && !error && <p className="widget-empty">Loading fabric…</p>}

      {tab === "map" && topo && (
        <div className="network-body">
          <div className="network-map">
            <FabricMap
              topo={topo}
              live={live}
              hallFilter={hallFilter}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <div className="network-legend">
              <span>
                <b data-k="spine" /> Spine
              </span>
              <span>
                <b /> Leaf
              </span>
              <span>
                <b data-k="up" /> Uplink 800G
              </span>
              <span>Click a leaf to expand hosts</span>
            </div>
          </div>
          <aside className="network-side">
            <header>
              <small>Selected</small>
              {selected ? (
                <>
                  <strong>{selected.label}</strong>
                  <span>
                    {selected.id} · {selected.role.toUpperCase()}
                  </span>
                </>
              ) : (
                <strong>Click any node or link</strong>
              )}
            </header>
            <div className="network-side-body">
              {selected ? (
                <>
                  <TrafficBars
                    tx={selectedLive?.tx_gbps ?? 0}
                    rx={selectedLive?.rx_gbps ?? 0}
                    cap={selected.role === "rack" ? 800 : 800 * 8}
                  />
                  <div className="traffic-block">
                    <h3>Details</h3>
                    <dl className="side-meta">
                      <div>
                        <dt>Role</dt>
                        <dd>{selected.role}</dd>
                      </div>
                      <div>
                        <dt>Hall</dt>
                        <dd>{selected.hall_name ?? "core"}</dd>
                      </div>
                      <div>
                        <dt>Ports</dt>
                        <dd>{selected.ports}</dd>
                      </div>
                      <div>
                        <dt>Links</dt>
                        <dd>{selectedLinks.length}</dd>
                      </div>
                      <div>
                        <dt>Speed</dt>
                        <dd>{topo.summary.speed}</dd>
                      </div>
                      <div>
                        <dt>Util</dt>
                        <dd>{selectedLive?.util_pct ?? 0}%</dd>
                      </div>
                    </dl>
                  </div>
                </>
              ) : (
                <p className="network-empty">Select a switch or host to see live traffic and port details</p>
              )}
            </div>
          </aside>
        </div>
      )}

      {tab === "ports" && (
        <div className="ports-layout">
          <aside className="ports-face">
            <select
              className="field"
              value={switchId}
              onChange={(e) => {
                setSwitchId(e.target.value);
                setCage("");
              }}
              aria-label="Switch"
            >
              {switchNames.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            {switchId && (
              <PortFaceplate system={switchId} ports={ports} picked={cage} onPick={setCage} />
            )}
          </aside>
          <div className="ports-table">
            <div className="cluster-toolbar" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="cluster-tools" style={{ marginLeft: 0 }}>
                <input
                  className="field"
                  placeholder="Filter nodes (e.g. SP-01, DH-01)"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select className="field" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Role">
                  <option value="">All roles</option>
                  <option value="uplink">Uplink</option>
                  <option value="downlink">Downlink</option>
                  <option value="host">Host</option>
                  <option value="spine">Spine</option>
                </select>
                <select className="field" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} aria-label="State">
                  <option value="">All states</option>
                  <option value="Active">Active</option>
                  <option value="Down">Down</option>
                </select>
              </div>
            </div>
            <div className="network-table-wrap">
              <table className="network-table">
                <thead>
                  <tr>
                    <th>Local system</th>
                    <th>Logical</th>
                    <th>Physical port</th>
                    <th>Peer system</th>
                    <th>Peer port</th>
                    <th>State</th>
                    <th>Speed</th>
                    <th>Cable PN</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {ports
                    .filter((p) => !switchId || p.local_system === switchId)
                    .filter((p) => !cage || p.local_port === cage)
                    .map((p, i) => (
                      <tr
                        key={`${p.local_system}:${p.local_port}:${p.peer_system}:${i}`}
                        data-state={p.state}
                        data-sel={cage === p.local_port ? "true" : "false"}
                      >
                        <td>
                          <b>{p.local_system}</b>
                        </td>
                        <td>{p.local_port}</td>
                        <td>{p.physical_port ?? `QSFP-DD ${p.local_port}`}</td>
                        <td>{p.peer_system || "—"}</td>
                        <td>{p.peer_port}</td>
                        <td className="port-state">{p.state}</td>
                        <td>{p.speed}</td>
                        <td>{p.cable_pn}</td>
                        <td>{p.role}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="network-count">
              {switchId ? `${switchId} · QSFP-DD cages` : `Showing ${ports.length} of ${portCount} ports`}
              {topo ? ` · ${topo.summary.active_ports}/${topo.summary.total_ports} active` : ""}
            </div>
          </div>
        </div>
      )}

      {tab === "traffic" && (
        <div className="traffic-dash">
          <div className="kpi-row">
            <article className="kpi">
              <dt>Fabric Tx</dt>
              <dd>{live ? formatGbps(live.total_tx_gbps) : "—"}</dd>
              {spark && (
                <svg className="spark" viewBox="0 0 120 36" aria-hidden>
                  <polygon points={spark.area} />
                  <polyline points={spark.line} />
                </svg>
              )}
            </article>
            <article className="kpi">
              <dt>Fabric Rx</dt>
              <dd>{live ? formatGbps(live.total_rx_gbps) : "—"}</dd>
              <small>Simulated IB counters · 2s poll</small>
            </article>
            <article className="kpi">
              <dt>Active links</dt>
              <dd>{live?.active_links ?? "—"}</dd>
              <small>{topo ? `${topo.summary.speed} Quantum-2` : ""}</small>
            </article>
            <article className="kpi">
              <dt>Hottest util</dt>
              <dd>{hottest[0] ? `${hottest[0].util_pct}%` : "—"}</dd>
              <small>{hottest[0] ? `${hottest[0].from_name} → ${hottest[0].to_name}` : ""}</small>
            </article>
          </div>

          <div className="traffic-grid">
            <article className="widget network-widget">
              <header>
                <h2>Hottest links</h2>
                <span>Tx / Rx</span>
              </header>
              <div className="health-table-wrap">
                <table className="network-table">
                  <thead>
                    <tr>
                      <th>Link</th>
                      <th>Role</th>
                      <th>Tx</th>
                      <th>Rx</th>
                      <th>Util</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hottest.slice(0, 24).map((l: LiveLink) => (
                      <tr
                        key={l.id}
                        data-state={l.state}
                        data-sel={selectedId === l.from_id || selectedId === l.to_id ? "true" : "false"}
                        onClick={() => setSelectedId(l.from_id)}
                      >
                        <td>
                          <b>{l.from_name}</b> → {l.to_name}
                        </td>
                        <td>{l.role}</td>
                        <td>{formatGbps(l.tx_gbps)}</td>
                        <td>{formatGbps(l.rx_gbps)}</td>
                        <td>
                          <div className="tbar-track" style={{ width: "4.5rem" }}>
                            <i style={{ width: `${Math.min(100, l.util_pct)}%` }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="widget network-widget">
              <header>
                <h2>Spine layer</h2>
                <span>{spineNodes.length} switches</span>
              </header>
              <div className="spine-grid">
                {spineNodes.map((n) => {
                  const t = live?.nodes[n.id];
                  return (
                    <button
                      type="button"
                      key={n.id}
                      className="spine-cell"
                      data-sel={selectedId === n.id ? "true" : "false"}
                      onClick={() => {
                        setSelectedId(n.id);
                        setTab("map");
                      }}
                    >
                      <b>{n.name}</b>
                      <span>
                        Tx {t ? formatGbps(t.tx_gbps) : "—"}
                        <br />
                        Rx {t ? formatGbps(t.rx_gbps) : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
              {selected && selectedLive && (
                <div style={{ padding: "0 0.85rem 0.9rem" }}>
                  <TrafficBars
                    tx={selectedLive.tx_gbps}
                    rx={selectedLive.rx_gbps}
                    cap={selected.role === "rack" ? 800 : 800 * 8}
                  />
                </div>
              )}
            </article>
          </div>
        </div>
      )}
    </div>
  );
}
