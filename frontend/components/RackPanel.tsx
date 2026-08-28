"use client";

import type { ClusterDevice, ClusterRack } from "@/lib/cluster";
import { GB300_ELEVATION, KIND_LABEL, POWER_LABEL, RUN_LABEL, STATUS_LABEL } from "@/lib/cluster";

function occupant(devices: ClusterDevice[], u: number): ClusterDevice | null {
  return devices.find((d) => u >= d.u_start && u < d.u_start + d.u_height) ?? null;
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="usage-meter">
      <div className="usage-meter-label">
        <span>{label}</span>
        <b>{Math.round(value)}%</b>
      </div>
      <div className="meter" aria-hidden>
        <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

export function RackPanel({
  rack,
  tab,
  onTab,
  canEdit,
  busy,
  onClose,
  onRotate,
  onRename,
  onDelete,
  onPower,
  onRestart,
}: {
  rack: ClusterRack;
  tab: "overview" | "details";
  onTab: (tab: "overview" | "details") => void;
  canEdit: boolean;
  busy?: boolean;
  onClose: () => void;
  onRotate: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onPower: (state: "on" | "off") => void;
  onRestart: () => void;
}) {
  const catalog: ClusterDevice[] =
    rack.devices.length > 0
      ? rack.devices
      : GB300_ELEVATION.map((d) => ({ ...d, rack_id: rack.id }));
  const units = [];
  for (let u = rack.height_u; u >= 1; u--) units.push(u);
  const occupied = catalog.filter((d) => d.kind !== "empty");
  const issues = occupied.filter((d) => d.status !== "healthy");
  const off = rack.power_state === "off";
  const run = off ? "idle" : rack.run_status || "ready";

  return (
    <aside className="rack-panel" aria-label="Rack details" onPointerDown={(e) => e.stopPropagation()}>
      <header className="rack-panel-head">
        <nav className="rack-panel-tabs">
          <button type="button" data-active={tab === "overview"} onClick={() => onTab("overview")}>
            Rack Overview
          </button>
          <button type="button" data-active={tab === "details"} onClick={() => onTab("details")}>
            Rack Details
          </button>
        </nav>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div className="rack-panel-title">
        {canEdit ? (
          <input
            className="rack-name-field"
            defaultValue={rack.name}
            key={rack.id + rack.name}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next && next !== rack.name) onRename(next);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        ) : (
          <strong>{rack.name}</strong>
        )}
        <span>
          (x: {rack.x}, y: {rack.y})
        </span>
        <div className="rack-chips">
          <span className="chip" data-tone={off ? "off" : "on"}>
            Power {POWER_LABEL[off ? "off" : "on"]}
          </span>
          <span className="chip" data-tone={run}>
            {RUN_LABEL[run] ?? run}
          </span>
        </div>
      </div>

      <div className="rack-usage">
        <Meter label="CPU" value={rack.cpu_pct ?? 0} />
        <Meter label="GPU" value={rack.gpu_pct ?? 0} />
        <Meter label="Mem" value={rack.mem_pct ?? 0} />
        <div className="usage-meter">
          <div className="usage-meter-label">
            <span>Power</span>
            <b>{rack.power_kw ? `${rack.power_kw.toFixed(0)} kW` : `${Math.round(rack.power_pct ?? 0)}%`}</b>
          </div>
          <div className="meter" aria-hidden>
            <i style={{ width: `${Math.max(0, Math.min(100, rack.power_pct ?? 0))}%` }} />
          </div>
        </div>
      </div>

      {canEdit && (
        <div className="rack-power-actions">
          <button type="button" className="btn" disabled={busy || !off} onClick={() => onPower("on")}>
            Power on
          </button>
          <button type="button" className="btn" disabled={busy || off} onClick={() => onPower("off")}>
            Power off
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || off} onClick={onRestart}>
            Restart
          </button>
        </div>
      )}

      {tab === "overview" ? (
        <div className="rack-elev">
          <div className="rack-elev-frame" data-off={off}>
            {units.map((u) => {
              const d = occupant(catalog, u);
              const showLabel = d && u === d.u_start + d.u_height - 1;
              return (
                <div
                  key={u}
                  className="rack-u"
                  data-kind={d?.kind ?? "gap"}
                  data-status={off ? "offline" : (d?.status ?? "empty")}
                  title={d ? `${d.name} · U${d.u_start}` : `U${u} empty`}
                >
                  {showLabel ? d!.name.split("-").slice(-1)[0] : ""}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rack-details">
          <dl>
            <div>
              <dt>Position</dt>
              <dd>
                x {rack.x} · y {rack.y} · {rack.rotation}°
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                {off ? "Powered off" : RUN_LABEL[run] ?? run}
              </dd>
            </div>
            <div>
              <dt>Height</dt>
              <dd>{rack.height_u}U</dd>
            </div>
            <div>
              <dt>Devices</dt>
              <dd>
                {occupied.length} occupied · {issues.length} flagged
              </dd>
            </div>
            <div>
              <dt>Notes</dt>
              <dd>{rack.notes || "—"}</dd>
            </div>
          </dl>
          {canEdit && (
            <div className="rack-actions">
              <button type="button" className="btn" onClick={onRotate}>
                Rotate 90°
              </button>
              <button type="button" className="btn btn-danger" onClick={onDelete}>
                Delete rack
              </button>
            </div>
          )}
          <table className="rack-dev-table">
            <thead>
              <tr>
                <th>U</th>
                <th>Device</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {occupied
                .slice()
                .sort((a, b) => b.u_start - a.u_start)
                .map((d) => (
                  <tr key={d.id} data-status={off ? "offline" : d.status}>
                    <td>{d.u_start}</td>
                    <td>{d.name}</td>
                    <td>{KIND_LABEL[d.kind] ?? d.kind}</td>
                    <td>{off ? "Off" : STATUS_LABEL[d.status] ?? d.status}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}
