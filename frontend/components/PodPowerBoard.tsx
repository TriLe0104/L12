"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "@/lib/api";
import type {
  ClusterHealth,
  ClusterHealthNode,
  InventoryNode,
  MaxLpsInvNode,
  MaxLpsInvRack,
  MaxLpsShelf,
  PowerLimiter,
  PowerRack,
} from "@/lib/cluster";
import { formatRackKw } from "@/lib/cluster";
import { Gb300PowerStencil, rackLimiterView } from "@/components/Gb300PowerStencil";
import { usePowerLimiter } from "@/components/PowerLimiter";

const NODES_PER_RACK = 18;
const SHELVES_PER_RACK = 8;
const POD_SPAN = 8;

export type PickedNode = {
  key: string;
  rackId: string;
  index: number;
  bmcIp?: string | null;
  osIp?: string | null;
  hostname?: string | null;
  serial?: string | null;
  bmcUser?: string | null;
  bmcPassword?: string | null;
  osUser?: string | null;
  osPassword?: string | null;
  label?: string;
};

type InfraView = "racks" | "devices" | "nodes";

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

function IconNodes() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="5" y="3.5" width="14" height="2.1" rx="0.4" fill="currentColor" />
      <rect x="5" y="7.1" width="14" height="2.1" rx="0.4" fill="currentColor" />
      <rect x="5" y="10.7" width="14" height="2.1" rx="0.4" fill="currentColor" />
      <rect x="5" y="14.3" width="14" height="2.1" rx="0.4" fill="currentColor" />
      <rect x="5" y="17.9" width="14" height="2.1" rx="0.4" fill="currentColor" />
    </svg>
  );
}

function placeholderNode(rackId: string, index: number): MaxLpsInvNode {
  return {
    id: `${rackId}-n${index}`,
    rack_id: rackId,
    index,
    serial: null,
    hostname: null,
    bmc_mac: null,
    bmc_ip: null,
    bmc_user: null,
    os_mac: null,
    os_ip: null,
    gpu_count: 0,
  };
}

function slotsForRack(rack: PodRack, inv: MaxLpsInvRack[]): MaxLpsInvNode[] {
  const found = inv.find((r) => r.id === rack.id);
  const byIndex = new Map((found?.nodes ?? []).map((n) => [n.index, n]));
  return Array.from({ length: NODES_PER_RACK }, (_, i) => byIndex.get(i + 1) ?? placeholderNode(rack.id, i + 1));
}

function liveFor(node: MaxLpsInvNode, health: ClusterHealth | null): ClusterHealthNode | undefined {
  const ip = (node.bmc_ip || "").trim();
  if (!ip) return undefined;
  return health?.nodes?.find((n) => n.bmc_ip === ip);
}

function presentNode(node: MaxLpsInvNode) {
  return Boolean((node.serial || "").trim() || (node.bmc_ip || "").trim() || (node.hostname || "").trim());
}

function credsFor(node: MaxLpsInvNode, prov: InventoryNode[]) {
  const ip = (node.bmc_ip || "").trim();
  const serial = (node.serial || "").trim();
  const os = (node.os_ip || "").trim();
  const match = prov.find((row) => {
    if (ip && (row.bmc_ip || "").trim() === ip) return true;
    if (serial && (row.serial || "").trim() === serial) return true;
    if (os && (row.os_ip || "").trim() === os) return true;
    return false;
  });
  return {
    bmcUser: node.bmc_user || match?.bmc_user || "",
    bmcPassword: node.bmc_password || match?.bmc_password || "",
    osUser: node.os_username || match?.os_username || "",
    osPassword: node.os_password || match?.os_password || "",
  };
}

function LoginLine({
  kind,
  ip,
  user,
  password,
}: {
  kind: string;
  ip?: string | null;
  user?: string | null;
  password?: string | null;
}) {
  if (!(ip || "").trim() && !(user || "").trim() && !(password || "").trim()) return null;
  return (
    <span className="pod-cred">
      <em>{kind}</em>
      <span>{(ip || "").trim() || "no IP"}</span>
      <span>
        {(user || "").trim() || "—"} / {(password || "").trim() || "—"}
      </span>
    </span>
  );
}

function presentShelf(shelf: { ip?: string | null; serial?: string | null; mac?: string | null }) {
  return Boolean((shelf.ip || "").trim() || (shelf.serial || "").trim() || (shelf.mac || "").trim());
}

function nodeTone(node: MaxLpsInvNode, live?: ClusterHealthNode) {
  if (live?.status) return live.status;
  if ((node.bmc_ip || "").trim()) return "unknown";
  return "empty";
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

function RackColumn({
  rack,
  view,
  limiter,
  inv,
  health,
  selectedKey,
  onSelectNode,
}: {
  rack: PodRack;
  view: InfraView;
  limiter: PowerLimiter | null;
  inv: MaxLpsInvRack[];
  health: ClusterHealth | null;
  selectedKey: string | null;
  onSelectNode?: (node: PickedNode) => void;
}) {
  const lines = splitSerial(rack.serial);
  const fill = Math.max(rack.partial ? 18 : 6, rack.pct);
  const kwLabel = rack.off || (rack.partial && rack.consumedKw < 0.05) ? "— kW" : formatRackKw(rack.consumedKw);
  const pr = limiter?.racks?.find((r) => r.id === rack.id);
  const stencil = rackLimiterView(limiter, pr);
  const slots = slotsForRack(rack, inv);
  const hits = slots.map((slot) => {
    const live = liveFor(slot, health);
    return {
      index: slot.index,
      status: nodeTone(slot, live),
      selected: selectedKey === `${rack.id}:${slot.index}`,
      title: slot.hostname || slot.bmc_ip || `Node ${slot.index}`,
    };
  });
  return (
    <div
      className="pod-rack"
      data-partial={rack.partial ? "true" : undefined}
      data-stencil={view === "racks" ? "true" : undefined}
      data-nodes={view === "nodes" ? "true" : undefined}
      data-on={selectedKey === `rack:${rack.id}` ? "true" : undefined}
      onClick={() =>
        onSelectNode?.({
          key: `rack:${rack.id}`,
          rackId: rack.id,
          index: 0,
          label: rack.name,
        })
      }
      title={`${rack.name} summary`}
    >
      {view === "devices" ? (
        <div className="pod-rack-devices" aria-hidden>
          {Array.from({ length: Math.max(1, rack.shelves) }, (_, i) => (
            <i key={i} style={{ height: `${fill}%` }} />
          ))}
        </div>
      ) : view === "nodes" ? (
        <div className="pod-nodes" role="list">
          {[...slots].sort((a, b) => b.index - a.index).map((slot) => {
            const live = liveFor(slot, health);
            const key = `${rack.id}:${slot.index}`;
            const tone = nodeTone(slot, live);
            return (
              <button
                key={slot.id}
                type="button"
                className="pod-node"
                role="listitem"
                data-status={tone}
                data-on={selectedKey === key ? "true" : undefined}
                title={slot.hostname || slot.bmc_ip || `Node ${slot.index}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectNode?.({
                    key,
                    rackId: rack.id,
                    index: slot.index,
                    bmcIp: slot.bmc_ip,
                    osIp: slot.os_ip,
                    hostname: slot.hostname,
                    serial: slot.serial,
                    bmcUser: slot.bmc_user,
                    bmcPassword: slot.bmc_password,
                    osUser: slot.os_username,
                    osPassword: slot.os_password,
                    label: rack.name,
                  });
                }}
              >
                <em>n{String(slot.index).padStart(2, "0")}</em>
                <span>{live?.leak?.status === "ok" ? "Dry" : live ? (live.leak?.status ?? live.status) : slot.bmc_ip ? "BMC" : "—"}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="pod-rack-open">
          <Gb300PowerStencil
            mode="compact"
            usedKw={stencil.usedKw || rack.consumedKw}
            maxKw={stencil.maxKw || rack.capKw}
            minKw={stencil.minKw}
            denied={stencil.denied}
            off={rack.off}
            label={rack.name}
            nodes={hits}
            onSelectNode={(index) => {
              const slot = slots.find((s) => s.index === index);
              onSelectNode?.({
                key: `${rack.id}:${index}`,
                rackId: rack.id,
                index,
                bmcIp: slot?.bmc_ip,
                osIp: slot?.os_ip,
                hostname: slot?.hostname,
                serial: slot?.serial,
                bmcUser: slot?.bmc_user,
                bmcPassword: slot?.bmc_password,
                osUser: slot?.os_username,
                osPassword: slot?.os_password,
                label: rack.name,
              });
            }}
          />
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
  power,
  health = null,
  selectedKey = null,
  onSelectNode,
}: {
  power?: PowerLimiter | null;
  health?: ClusterHealth | null;
  selectedKey?: string | null;
  onSelectNode?: (node: PickedNode) => void;
}) {
  const local = usePowerLimiter(!power, 2000);
  const limiter = power ?? local.data;
  const [inv, setInv] = useState<MaxLpsInvRack[]>([]);
  const [live, setLive] = useState<MaxLpsShelf[]>([]);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState<InfraView>("racks");
  const [summaryId, setSummaryId] = useState<string | null>(null);
  const [provNodes, setProvNodes] = useState<InventoryNode[]>([]);

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
          /* empty until a rack is registered */
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
    () => (inv.length ? podsFromRegistered(inv, limiter, live) : []),
    [inv, limiter, live],
  );
  useEffect(() => {
    if (!summaryId) return;
    let stop = false;
    api
      .provision({ sync: false })
      .then((snap) => {
        if (!stop) setProvNodes(snap.nodes || []);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [summaryId]);

  useEffect(() => {
    if (!summaryId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSummaryId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [summaryId]);

  const summary = inv.find((rack) => rack.id === summaryId) || null;
  const summaryNodes = (summary?.nodes || []).filter(presentNode);
  const summaryShelves = (summary?.shelves || []).filter(presentShelf);
  const summaryLabel = (summary?.label || "").trim().toLowerCase();
  const summarySwitches = provNodes.filter(
    (node) => node.kind === "switch" && (node.hall_name || "").trim().toLowerCase() === summaryLabel && summaryLabel,
  );
  const shown = filter === "all" ? pods : pods.filter((p) => p.id === filter);
  const liveOn = inv.length > 0 && (live.some((r) => r.shelf_kw > 0.05) || (limiter?.active.consumed_kw ?? 0) > 0.05);

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
            <button type="button" data-on={view === "nodes"} onClick={() => setView("nodes")}>
              <IconNodes /> Nodes
            </button>
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="pod-empty">No registered racks. Add a rack (manual or Argus) to show telemetry.</p>
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
                      <RackColumn
                        key={rack.id}
                        rack={rack}
                        view={view}
                        limiter={limiter}
                        inv={inv}
                        health={health}
                        selectedKey={summaryId ? `rack:${summaryId}` : selectedKey}
                        onSelectNode={(node) => {
                          if (node.key.startsWith("rack:")) {
                            setSummaryId((cur) => (cur === node.rackId ? null : node.rackId));
                            return;
                          }
                          setSummaryId(null);
                          onSelectNode?.(node);
                        }}
                      />
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
        {summary
          ? createPortal(
              <aside className="pod-summary" role="dialog" aria-label={`${summary.label} nodes`} onPointerDown={(e) => e.stopPropagation()}>
                <header>
                  <div>
                    <b>{summary.label}</b>
                    <small>
                      {summary.hall || "Unassigned"}
                      {summary.serial ? ` · ${summary.serial}` : ""}
                    </small>
                  </div>
                  <button type="button" className="icon-btn" onClick={() => setSummaryId(null)} aria-label="Close rack summary">
                    ×
                  </button>
                </header>
                <div className="pod-summary-body">
                  <p>
                    {summaryNodes.length} node{summaryNodes.length === 1 ? "" : "s"} available
                    {summarySwitches.length ? ` · ${summarySwitches.length} switch${summarySwitches.length === 1 ? "" : "es"}` : ""}
                    {summaryShelves.length ? ` · ${summaryShelves.length} power shelf${summaryShelves.length === 1 ? "" : "ves"}` : ""}
                  </p>
                  <div>
                    <h3>Nodes</h3>
                    {summaryNodes.length === 0 ? (
                      <span>No nodes with a serial or address on this rack.</span>
                    ) : (
                      <ul>
                        {summaryNodes.map((node) => {
                          const creds = credsFor(node, provNodes);
                          const openNode = () => {
                            setSummaryId(null);
                            onSelectNode?.({
                              key: `${summary.id}:${node.index}`,
                              rackId: summary.id,
                              index: node.index,
                              bmcIp: node.bmc_ip,
                              osIp: node.os_ip,
                              hostname: node.hostname,
                              serial: node.serial,
                              bmcUser: creds.bmcUser,
                              bmcPassword: creds.bmcPassword,
                              osUser: creds.osUser,
                              osPassword: creds.osPassword,
                              label: summary.label,
                            });
                          };
                          return (
                            <li key={node.id}>
                              <button type="button" className="pod-node-pick" onClick={openNode}>
                                <b>N{node.index}</b>
                                <span>
                                  <span className="pod-node-name">{node.hostname || node.serial || "node"}</span>
                                  {node.serial ? <span className="pod-node-serial">{node.serial}</span> : null}
                                  <LoginLine kind="BMC" ip={node.bmc_ip} user={creds.bmcUser} password={creds.bmcPassword} />
                                  <LoginLine kind="OS" ip={node.os_ip} user={creds.osUser} password={creds.osPassword} />
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                  {summarySwitches.length ? (
                    <div>
                      <h3>Switches</h3>
                      <ul>
                        {summarySwitches.map((node) => (
                          <li key={node.id}>
                            <b>{node.name}</b>
                            <div>
                              {node.serial ? <span className="pod-node-serial">{node.serial}</span> : null}
                              <LoginLine kind="BMC" ip={node.bmc_ip} user={node.bmc_user} password={node.bmc_password} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {summaryShelves.length ? (
                    <div>
                      <h3>Power shelves</h3>
                      <ul>
                        {summaryShelves.map((shelf) => (
                          <li key={shelf.id}>
                            <b>PS{shelf.index}</b>
                            <div>
                              <span className="pod-node-name">{shelf.model || shelf.serial || "shelf"}</span>
                              {shelf.serial ? <span className="pod-node-serial">{shelf.serial}</span> : null}
                              <LoginLine kind="BMC" ip={shelf.ip} user={shelf.user} password={shelf.password} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </aside>,
              document.body,
            )
          : null}
      </div>
    </section>
  );
}
