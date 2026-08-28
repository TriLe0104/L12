"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ThemeDialog } from "@/components/ThemeDialog";
import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type { InventoryNode, ProvisionSnapshot } from "@/lib/cluster";

import "../cluster/cluster.css";
import "./provision.css";

type SideTab = "dhcp" | "arp" | "sol";

export default function ProvisionPage() {
  const { user } = useAuth();
  const mayEdit = canEdit(user);
  const [data, setData] = useState<ProvisionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"all" | "compute" | "leaf" | "spine">("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [side, setSide] = useState<SideTab>("dhcp");
  const [dialog, setDialog] = useState(false);
  const [serials, setSerials] = useState("");
  const [log, setLog] = useState("");

  const load = useCallback(async () => {
    const snap = await api.provision();
    setData(snap);
    setFocus((cur) => cur ?? snap.nodes[0]?.id ?? null);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load inventory"));
  }, [load]);

  useEffect(() => {
    const active = data?.nodes.some((n) => ["pxe", "imaging", "sol"].includes(n.provision_status));
    if (!active) return;
    const id = window.setInterval(() => load().catch(() => undefined), 2000);
    return () => window.clearInterval(id);
  }, [data, load]);

  useEffect(() => {
    if (side !== "sol" || !focus) return;
    let stop = false;
    const tick = () =>
      api
        .provisionConsole(focus)
        .then((c) => {
          if (!stop) setLog(c.log);
        })
        .catch(() => undefined);
    tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [side, focus]);

  const nodes = useMemo(() => {
    const list = data?.nodes ?? [];
    const needle = q.trim().toLowerCase();
    return list.filter((n) => {
      if (kind !== "all" && n.kind !== kind) return false;
      if (!needle) return true;
      return `${n.name} ${n.serial} ${n.bmc_mac} ${n.bmc_ip} ${n.os_ip}`.toLowerCase().includes(needle);
    });
  }, [data, kind, q]);

  const focused: InventoryNode | undefined = data?.nodes.find((n) => n.id === focus);

  function toggle(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function run(fn: () => Promise<ProvisionSnapshot>) {
    setBusy(true);
    try {
      setData(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const ids = selected.length ? selected : focus ? [focus] : [];

  return (
    <div className="cluster-app provision-app">
      <div className="cluster-toolbar">
        <div className="cluster-tabs">
          <span className="cluster-kicker">Provision</span>
        </div>
        <div className="cluster-tools">
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Kind">
            <option value="all">Compute + switches</option>
            <option value="compute">Compute</option>
            <option value="leaf">Leaf</option>
            <option value="spine">Spine</option>
          </select>
          <input className="field" placeholder="Filter SN / MAC / IP" value={q} onChange={(e) => setQ(e.target.value)} />
          {mayEdit && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setDialog(true)}>
                Register SNs
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.provisionDiscover())}>
                DHCP / ARP scan
              </button>
              <button type="button" className="btn" disabled={busy || !ids.length} onClick={() => run(() => api.provisionRedfish(ids))}>
                Redfish OS IP
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !ids.length}
                onClick={() => {
                  setSide("sol");
                  run(() => api.provisionPxe(ids));
                }}
              >
                PXE boot
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p className="cluster-error">
          {error}{" "}
          <button type="button" className="btn" onClick={() => { setError(null); load(); }}>
            Retry
          </button>
        </p>
      )}
      <div className="provision-body">
        <div className="provision-col">
          <div className="network-count">
            {data
              ? `${data.summary.compute} compute · ${data.summary.switches} switches · ${data.summary.leases} leases`
              : "Loading…"}
          </div>
          <div className="network-table-wrap">
            <table className="network-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>SN</th>
                  <th>Kind</th>
                  <th>BMC MAC</th>
                  <th>BMC IP</th>
                  <th>OS IP</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr
                    key={n.id}
                    className="inv-row"
                    data-sel={focus === n.id ? "true" : "false"}
                    onClick={() => setFocus(n.id)}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(n.id)}
                        onChange={() => toggle(n.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td>
                      <b>{n.name}</b>
                    </td>
                    <td>{n.serial}</td>
                    <td>{n.kind}</td>
                    <td>{n.bmc_mac ?? "—"}</td>
                    <td>{n.bmc_ip ?? "—"}</td>
                    <td>{n.os_ip ?? "—"}</td>
                    <td className={`status-${n.provision_status}`}>{n.provision_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="provision-col">
          <div className="provision-tabs">
            <button type="button" data-active={side === "dhcp"} onClick={() => setSide("dhcp")}>
              DHCP leases
            </button>
            <button type="button" data-active={side === "arp"} onClick={() => setSide("arp")}>
              ARP scan
            </button>
            <button type="button" data-active={side === "sol"} onClick={() => setSide("sol")}>
              KVM / SOL
            </button>
          </div>
          {side === "dhcp" && (
            <div className="network-table-wrap">
              <table className="network-table">
                <thead>
                  <tr>
                    <th>IP</th>
                    <th>MAC</th>
                    <th>Hostname</th>
                    <th>Mapped</th>
                    <th>Iface</th>
                    <th>Lease</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.dhcp ?? []).map((r) => (
                    <tr key={`${r.ip}-${r.mac}`}>
                      <td>{r.ip}</td>
                      <td>{r.mac}</td>
                      <td>{r.hostname}</td>
                      <td>
                        <b>{r.mapped}</b>
                      </td>
                      <td>{r.iface}</td>
                      <td>{r.lease}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {side === "arp" && (
            <div className="network-table-wrap">
              <table className="network-table">
                <thead>
                  <tr>
                    <th>IP</th>
                    <th>MAC</th>
                    <th>Vendor</th>
                    <th>Mapped node</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.arp ?? []).map((r) => (
                    <tr key={`${r.ip}-${r.mac}`}>
                      <td>{r.ip}</td>
                      <td>{r.mac}</td>
                      <td>{r.vendor}</td>
                      <td>
                        <b>{r.mapped}</b>
                      </td>
                      <td>{r.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {side === "sol" && (
            <pre className="console">
              {focused
                ? log || focused.sol_log || `No SOL session for ${focused.name}. Start PXE to open the console.`
                : "Select a node."}
            </pre>
          )}
        </div>
      </div>

      {dialog && (
        <ThemeDialog
          title="Register cluster"
          confirmLabel="Pull from SPM"
          busy={busy}
          onClose={() => setDialog(false)}
          onConfirm={async () => {
            const list = serials
              .split(/\s+/)
              .map((s) => s.trim())
              .filter(Boolean);
            await run(() => api.provisionRegister(list));
            setDialog(false);
          }}
        >
          <p className="widget-meta" style={{ margin: "0 0 0.6rem" }}>
            Paste rack serials. SPM returns SN, BMC MAC, and BMC password. DHCP then maps MAC → BMC IP; Redfish reads the OS NIC.
            Demo serials look like <code>SN-DH-01-R01C01</code>.
          </p>
          <textarea
            className="field serial-box"
            value={serials}
            onChange={(e) => setSerials(e.target.value)}
            placeholder={"SN-DH-01-R01C01\nSN-DH-01-R01C02"}
          />
        </ThemeDialog>
      )}
    </div>
  );
}
