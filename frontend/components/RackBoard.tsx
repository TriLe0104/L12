"use client";

import { useMemo, useState } from "react";

import type { ClusterRack, HallDetail } from "@/lib/cluster";
import { formatRackKw, GB300_ELEVATION, POWER_LABEL, RUN_LABEL } from "@/lib/cluster";

function hid(text: string, n = 4) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) >>> 0;
  return (h % 10 ** n).toString().padStart(n, "0");
}

function nodeIps(rack: ClusterRack, hallIndex: number, rackIndex: number) {
  if (rack.serial || rack.bmc_ip || rack.os_ip) {
    const node = rack.devices.find((d) => d.kind === "compute" && d.check_value);
    return {
      serial: rack.serial || rack.notes || rack.name,
      bmc_ip: rack.bmc_ip || node?.check_value || null,
      os_ip: rack.os_ip || null,
      bmc_mac: rack.bmc_mac || "—",
    };
  }
  const host = 10 + (rackIndex % 240);
  const vlan = hallIndex + 1;
  return {
    serial: `SN-${rack.name}`,
    bmc_ip: rack.power_state === "off" ? null : `172.31.${vlan}.${host}`,
    os_ip: rack.power_state === "off" ? null : `10.20.${vlan}.${host}`,
    bmc_mac: `3c:6d:66:${hid(rack.name + "b", 2)}:${hid(rack.name + "c", 2)}:${hid(rack.name + "d", 2)}`,
  };
}

const TRAYS = [
  { id: "t1", name: "GB300-T1", gpus: 18, u: "9–16" },
  { id: "t2", name: "GB300-T2", gpus: 18, u: "18–25" },
  { id: "t3", name: "GB300-T3", gpus: 18, u: "30–37" },
  { id: "t4", name: "GB300-T4", gpus: 18, u: "39–46" },
];

export function RackBoard({ halls }: { halls: HallDetail[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [hallFilter, setHallFilter] = useState("");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list: { hall: HallDetail; hallIndex: number; rack: ClusterRack; rackIndex: number }[] = [];
    halls.forEach((hall, hallIndex) => {
      if (hallFilter && hall.id !== hallFilter) return;
      hall.racks.forEach((rack, rackIndex) => {
        if (needle && !`${rack.name} ${hall.name} ${rack.run_status}`.toLowerCase().includes(needle)) return;
        list.push({ hall, hallIndex, rack, rackIndex });
      });
    });
    return list;
  }, [halls, hallFilter, q]);

  return (
    <section className="rack-board">
      <div className="cluster-toolbar" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="cluster-tools" style={{ marginLeft: 0 }}>
          <select className="field" value={hallFilter} onChange={(e) => setHallFilter(e.target.value)} aria-label="Hall filter">
            <option value="">All halls</option>
            {halls.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} · {h.racks.length} racks
              </option>
            ))}
          </select>
          <input className="field" placeholder="Filter rack" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="network-count" style={{ border: 0, padding: 0 }}>
            {rows.length} racks
          </span>
        </div>
      </div>
      <div className="network-table-wrap rack-board-table">
        <table className="network-table">
          <thead>
            <tr>
              <th></th>
              <th>Rack</th>
              <th>Hall</th>
              <th>Power</th>
              <th>Status</th>
              <th>GPU</th>
              <th>CPU</th>
              <th>Mem</th>
              <th>kW</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ hall, hallIndex, rack, rackIndex }) => {
              const expanded = open === rack.id;
              const net = nodeIps(rack, hallIndex, rackIndex);
              const off = rack.power_state === "off";
              return (
                <RackRows
                  key={rack.id}
                  rack={rack}
                  hallName={hall.name}
                  expanded={expanded}
                  net={net}
                  off={off}
                  onToggle={() => setOpen(expanded ? null : rack.id)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RackRows({
  rack,
  hallName,
  expanded,
  net,
  off,
  onToggle,
}: {
  rack: ClusterRack;
  hallName: string;
  expanded: boolean;
  net: { serial: string; bmc_ip: string | null; os_ip: string | null; bmc_mac: string };
  off: boolean;
  onToggle: () => void;
}) {
  const devices = rack.devices.length ? rack.devices : GB300_ELEVATION;
  return (
    <>
      <tr className="inv-row" data-sel={expanded ? "true" : "false"} onClick={onToggle}>
        <td className="rack-caret">{expanded ? "▾" : "▸"}</td>
        <td>
          <b>{rack.name}</b>
        </td>
        <td>{hallName}</td>
        <td>{POWER_LABEL[rack.power_state] ?? rack.power_state}</td>
        <td>{off ? "Off" : (RUN_LABEL[rack.run_status] ?? rack.run_status)}</td>
        <td>{rack.gpu_pct > 0 ? `${Math.round(rack.gpu_pct)}%` : "—"}</td>
        <td>{rack.cpu_pct > 0 ? `${Math.round(rack.cpu_pct)}%` : "—"}</td>
        <td>{rack.mem_pct > 0 ? `${Math.round(rack.mem_pct)}%` : "—"}</td>
        <td>{formatRackKw(rack.power_kw)}</td>
      </tr>
      {expanded && (
        <tr className="rack-drop">
          <td colSpan={9}>
            <div className="node-drop">
              <dl className="node-meta">
                <div>
                  <dt>Serial</dt>
                  <dd>{net.serial}</dd>
                </div>
                <div>
                  <dt>BMC</dt>
                  <dd>
                    {net.bmc_ip ?? "—"} <span>{net.bmc_mac}</span>
                  </dd>
                </div>
                <div>
                  <dt>OS IP</dt>
                  <dd>{net.os_ip ?? "—"}</dd>
                </div>
                <div>
                  <dt>Height</dt>
                  <dd>{rack.height_u}U</dd>
                </div>
              </dl>
              <table className="network-table node-table">
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Role</th>
                    <th>U</th>
                    <th>GPUs</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(rack.devices.filter((d) => d.kind === "compute").length
                    ? rack.devices
                        .filter((d) => d.kind === "compute")
                        .map((d) => (
                          <tr key={d.id}>
                            <td>
                              <b>{d.name}</b>
                            </td>
                            <td>Compute</td>
                            <td>
                              {d.u_start}–{d.u_start + d.u_height - 1}
                            </td>
                            <td>{off ? 0 : 4}</td>
                            <td>{off ? "offline" : d.status}</td>
                          </tr>
                        ))
                    : TRAYS.map((t, i) => (
                        <tr key={t.id}>
                          <td>
                            <b>
                              {rack.name}-{t.id.toUpperCase()}
                            </b>
                          </td>
                          <td>{t.name}</td>
                          <td>{t.u}</td>
                          <td>{off ? 0 : t.gpus}</td>
                          <td>{off ? "offline" : i === 0 && rack.run_status === "idle" ? "idle" : "healthy"}</td>
                        </tr>
                      )))}
                  {devices
                    .filter((d) => d.kind === "switch" || d.kind === "power")
                    .map((d) => (
                      <tr key={d.id}>
                        <td>
                          <b>
                            {rack.name}-{d.name}
                          </b>
                        </td>
                        <td>{d.name}</td>
                        <td>
                          {d.u_start}–{d.u_start + d.u_height - 1}
                        </td>
                        <td>—</td>
                        <td>{off ? "offline" : d.status}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
