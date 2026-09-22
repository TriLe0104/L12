"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ThemeDialog } from "@/components/ThemeDialog";
import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type { InventoryNode, ProvisionRack, ProvisionSnapshot } from "@/lib/cluster";

import "../cluster/cluster.css";
import "./provision.css";

type GroupKey = "compute" | "leaf" | "power";

export default function ProvisionPage() {
  const { user } = useAuth();
  const mayEdit = canEdit(user);
  const [data, setData] = useState<ProvisionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [hopOpen, setHopOpen] = useState(false);
  const [hopHost, setHopHost] = useState("172.25.231.244");
  const [hopUser, setHopUser] = useState("root");
  const [hopPass, setHopPass] = useState("");
  const [log, setLog] = useState("");
  const [openRacks, setOpenRacks] = useState<Record<string, boolean>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [kvm, setKvm] = useState<{ url: string; name: string; user: string; kind: "kvm" | "sol" | "bmc" } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [portalScale, setPortalScale] = useState(150);
  const [expanded, setExpanded] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [clipText, setClipText] = useState("");
  const [clipNote, setClipNote] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("l12-provision-portal-scale");
      const n = raw ? Number(raw) : NaN;
      if (n >= 100 && n <= 200) setPortalScale(n);
    } catch {
      /* ignore */
    }
  }, []);

  function sendPortalScale(scale = portalScale) {
    const factor = scale / 100;
    try {
      window.sessionStorage.setItem("l12-console-scale", String(factor));
    } catch {
      /* ignore */
    }
    try {
      iframeRef.current?.contentWindow?.postMessage({ type: "l12-scale", scale: factor }, "*");
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    sendPortalScale();
    if (!kvm?.url) return;
    const id = window.setInterval(() => sendPortalScale(), 400);
    return () => window.clearInterval(id);
  }, [portalScale, kvm?.url]);

  useEffect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === "l12-scale-ready") sendPortalScale();
      if (e.data?.type === "l12-clipboard") {
        const text = String(e.data.text || "");
        setClipText(text);
        if (text) {
          void navigator.clipboard.writeText(text).catch(() => undefined);
          setClipNote("Copied from KVM");
        } else {
          setClipNote("KVM clipboard is empty — copy in the guest first");
        }
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [portalScale]);

  function postIframe(payload: Record<string, unknown>) {
    try {
      iframeRef.current?.contentWindow?.postMessage(payload, "*");
    } catch {
      /* ignore */
    }
  }

  async function pasteToKvm() {
    let text = clipText;
    if (!text) {
      try {
        text = await navigator.clipboard.readText();
        setClipText(text);
      } catch {
        setClipNote("Allow clipboard access or paste into the box");
        return;
      }
    }
    if (!text) {
      setClipNote("Nothing to paste");
      return;
    }
    postIframe({ type: "l12-clipboard-paste", text });
    setClipNote("Sent to KVM — Ctrl+V in the guest if it does not appear");
  }

  function copyFromKvm() {
    postIframe({ type: "l12-clipboard-request" });
    setClipNote("Waiting for KVM clipboard…");
  }

  function bumpPortalScale(dir: -1 | 1) {
    const steps = [100, 115, 125, 150, 175, 200];
    const i = steps.findIndex((s) => s >= portalScale);
    const cur = i < 0 ? 0 : steps[i] === portalScale ? i : Math.max(0, i - 1);
    const next = steps[Math.max(0, Math.min(steps.length - 1, cur + dir))] ?? 125;
    setPortalScale(next);
    sendPortalScale(next);
    try {
      window.localStorage.setItem("l12-provision-portal-scale", String(next));
    } catch {
      /* ignore */
    }
  }

  function kvmUrl(launched: { path: string; url: string }, kind: "kvm" | "sol" | "bmc") {
    // Same origin as the app (Next rewrites /api → FastAPI) so BMC cookies are first-party.
    const raw = launched.path.startsWith("http") ? new URL(launched.path).pathname : launched.path;
    const base = raw.replace(/\/?$/, "/");
    const hash =
      kind === "sol" ? "#/console/serial-over-lan-console" : kind === "bmc" ? "#/" : "#/console/kvm";
    return `${base}?view=${kind}${hash}`;
  }

  async function openSession(kind: "kvm" | "sol" | "bmc") {
    if (!focused) return;
    if (!data?.hop?.connected) {
      setHopOpen(true);
      return;
    }
    setBusy(true);
    try {
      const launched = await api.provisionKvm(focused.id);
      setKvm({ url: kvmUrl(launched, kind), name: focused.name, user: launched.user || "ADMIN", kind });
      setClipOpen(false);
      setClipNote("");
      setDetailsOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : kind === "kvm" ? "KVM failed" : "SOL failed";
      if (msg.toLowerCase().includes("jump") || msg.includes("401")) setHopOpen(true);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(async () => {
    const snap = await api.provision();
    setData(snap);
    if (snap.hop?.host) setHopHost(snap.hop.host);
    if (snap.hop?.user) setHopUser(snap.hop.user);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load inventory"));
  }, [load]);

  const focused: InventoryNode | undefined = data?.nodes.find((n) => n.id === focus);

  useEffect(() => {
    if (!focus) return;
    let stop = false;
    api
      .provisionConsole(focus)
      .then((c) => {
        if (!stop) setLog(c.log);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [focus]);

  const filtered = useMemo(() => {
    const list = data?.nodes ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((n) =>
      `${n.name} ${n.serial} ${n.bmc_mac} ${n.bmc_ip} ${n.os_ip} ${n.hall_name}`.toLowerCase().includes(needle),
    );
  }, [data, q]);

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

  const racks = data?.racks?.length
    ? data.racks
    : ([
        {
          id: "all",
          serial: "",
          name: "Inventory",
          type: "",
          status: "",
          counts: { nodes: filtered.length, switches: 0, shelves: 0 },
        },
      ] as ProvisionRack[]);

  return (
    <div className="cluster-app provision-app">
      <div className="cluster-toolbar">
        <div className="cluster-tabs">
          <span className="cluster-kicker">Provision</span>
        </div>
        <div className="cluster-tools">
          <input className="field" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
          {mayEdit && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.provisionSync())}>
                Sync Argus
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setHopOpen(true)}>
                {data?.hop?.connected ? `PXE hop · ${data.hop.host}` : "PXE hop"}
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
              ? `${data.source === "argus" ? "Argus · " : ""}${data.summary.compute} nodes · ${data.summary.switches} switches · ${data.summary.shelves ?? 0} PS`
              : "Loading…"}
          </div>
          <div className="network-table-wrap">
            <table className="network-table prov-tree">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {racks.map((rack) => {
                  const kids = filtered.filter((n) =>
                    data?.racks?.length ? n.rack_id === rack.id || n.hall_name === rack.name : true,
                  );
                  const opened = openRacks[rack.id] ?? true;
                  return (
                    <RackTree
                      key={rack.id}
                      rack={rack}
                      kids={kids}
                      opened={opened}
                      openGroups={openGroups}
                      focus={focus}
                      onToggleRack={() => setOpenRacks((c) => ({ ...c, [rack.id]: !opened }))}
                      onToggleGroup={(g) => setOpenGroups((c) => ({ ...c, [g]: !(c[g] ?? g.endsWith(":compute")) }))}
                      onOpen={(id) => {
                        setFocus(id);
                        setKvm(null);
                        setDetailsOpen(true);
                      }}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <aside className="provision-pane" data-expanded={expanded ? "true" : undefined}>
          {!focused ? (
            <div className="provision-empty">
              <p>Select a node</p>
              <span>SOL and KVM run through the PXE hop over HTTPS — not IPMI.</span>
            </div>
          ) : (
            <div
              className="provision-sol"
              data-session={kvm ? "true" : undefined}
              style={{ ["--kvm-scale" as string]: String(portalScale / 100) }}
            >
              <header className="provision-pane-head">
                <div>
                  <p className="maxlps-kicker">{kindLabel(focused.kind)}</p>
                  <h2>{focused.name}</h2>
                </div>
                <div className="provision-zoom" role="group" aria-label="Console font and clipboard">
                  <button type="button" className="btn" disabled={portalScale <= 100} onClick={() => bumpPortalScale(-1)}>
                    A−
                  </button>
                  <span title="100% fits the full KVM screen. A+ zooms the console text; scroll if it overflows.">{portalScale}%</span>
                  <button type="button" className="btn" disabled={portalScale >= 200} onClick={() => bumpPortalScale(1)}>
                    A+
                  </button>
                  {kvm ? (
                    <button
                      type="button"
                      className="btn"
                      aria-pressed={clipOpen}
                      onClick={() => setClipOpen((v) => !v)}
                    >
                      Clipboard
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    aria-pressed={expanded}
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? "Collapse" : "Expand"}
                  </button>
                </div>
              </header>
              <button
                type="button"
                className="provision-creds"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((v) => !v)}
              >
                <i data-open={detailsOpen ? "true" : undefined} aria-hidden />
                <span>
                  <b>BMC</b> {focused.bmc_user || "—"} / {focused.bmc_password || "—"}
                  <small>{focused.bmc_ip || "no IP"}</small>
                </span>
                <span>
                  <b>OS</b> {focused.os_username || "—"} / {focused.os_password || "—"}
                  <small>{focused.os_ip || "no IP"}</small>
                </span>
              </button>
              {detailsOpen ? (
                <dl className="prov-dl">
                  <div>
                    <dt>Serial</dt>
                    <dd>{focused.serial}</dd>
                  </div>
                  <div>
                    <dt>Rack</dt>
                    <dd>{focused.hall_name ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>BMC MAC</dt>
                    <dd>{focused.bmc_mac ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{focused.provision_status}</dd>
                  </div>
                </dl>
              ) : null}
              {mayEdit && (
                <div className="provision-sol-bar">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !focused.bmc_mac}
                    onClick={async () => {
                      if (!data?.hop?.connected) {
                        setHopOpen(true);
                        return;
                      }
                      setBusy(true);
                      try {
                        const found = await api.provisionFindIp(focused.id);
                        setData((cur) =>
                          cur
                            ? {
                                ...cur,
                                nodes: cur.nodes.map((n) => (n.id === focused.id ? { ...n, bmc_ip: found.bmc_ip } : n)),
                              }
                            : cur,
                        );
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : "IP lookup failed";
                        if (msg.toLowerCase().includes("jump") || msg.includes("401")) setHopOpen(true);
                        setError(msg);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Find latest IP
                  </button>
                  {focused.kind === "compute" && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || !focused.bmc_ip}
                        onClick={() => {
                          if (!data?.hop?.connected) {
                            setHopOpen(true);
                            return;
                          }
                          void api.provisionConsole(focused.id).then((c) => setLog(c.log));
                        }}
                      >
                        Refresh SOL
                      </button>
                      <button
                        type="button"
                        className="btn"
                        data-active={kvm?.kind === "sol" ? "true" : undefined}
                        disabled={busy || !focused.bmc_ip}
                        onClick={() => void openSession("sol")}
                      >
                        Live SOL
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-active={kvm?.kind === "kvm" ? "true" : undefined}
                        disabled={busy || !focused.bmc_ip}
                        onClick={() => void openSession("kvm")}
                      >
                        Open KVM
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn"
                    data-active={kvm?.kind === "bmc" ? "true" : undefined}
                    disabled={busy || !focused.bmc_ip}
                    onClick={() => void openSession("bmc")}
                  >
                    Access BMC
                  </button>
                </div>
              )}
              {kvm ? (
                  <div className="provision-kvm-frame">
                    {clipOpen ? (
                      <div className="provision-clip">
                        <textarea
                          value={clipText}
                          onChange={(e) => setClipText(e.target.value)}
                          placeholder="Paste here, then send to KVM — or copy in the guest and pull it out"
                          rows={3}
                        />
                        <div className="provision-clip-actions">
                          <button type="button" className="btn btn-primary" onClick={() => void pasteToKvm()}>
                            Paste to KVM
                          </button>
                          <button type="button" className="btn" onClick={copyFromKvm}>
                            Copy from KVM
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              try {
                                const t = await navigator.clipboard.readText();
                                setClipText(t);
                                setClipNote("Loaded from this PC");
                              } catch {
                                setClipNote("Clipboard blocked — paste into the box");
                              }
                            }}
                          >
                            From PC
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(clipText);
                                setClipNote("Copied to this PC");
                              } catch {
                                setClipNote("Select the text and copy");
                              }
                            }}
                          >
                            To PC
                          </button>
                          {clipNote ? <small>{clipNote}</small> : null}
                        </div>
                      </div>
                    ) : null}
                    <iframe
                      ref={iframeRef}
                      title={`${kvm.kind} ${kvm.name}`}
                      src={kvm.url}
                      onLoad={() => sendPortalScale()}
                    />
                  </div>
              ) : (
                <pre className="console">{log || focused.sol_log || "SOL idle."}</pre>
              )}
            </div>
          )}
        </aside>
      </div>
      {hopOpen && (
        <ThemeDialog
          title="PXE jump host"
          confirmLabel="Connect"
          busy={busy}
          onClose={() => setHopOpen(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api.provisionHopConnect({ host: hopHost, username: hopUser, password: hopPass || undefined });
              setHopPass("");
              setHopOpen(false);
              await load();
              if (focus) {
                const c = await api.provisionConsole(focus);
                setLog(c.log);
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : "PXE hop failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="widget-meta" style={{ margin: "0 0 0.6rem" }}>
            BMC IPs sit behind the PXE server. SSH there first (root is fine). Password is kept in this API process only.
          </p>
          <label className="field-label">
            PXE IP
            <input className="field" value={hopHost} onChange={(e) => setHopHost(e.target.value)} placeholder="172.25.231.244" />
          </label>
          <label className="field-label">
            Username
            <input className="field" value={hopUser} onChange={(e) => setHopUser(e.target.value)} autoComplete="username" />
          </label>
          <label className="field-label">
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
      )}
    </div>
  );
}

function slotIndex(name: string) {
  const slot = name.match(/slot\s*(\d+)/i);
  if (slot) return Number(slot[1]);
  const ps = name.match(/ps\s*(\d+)/i) || name.match(/-ps(\d+)/i);
  if (ps) return Number(ps[1]);
  return 10_000;
}

function kindLabel(kind: string) {
  if (kind === "compute") return "Node";
  if (kind === "leaf" || kind === "spine") return "Switch";
  if (kind === "power") return "Power shelf";
  return kind;
}

const GROUPS: { key: GroupKey; label: string; kinds: string[] }[] = [
  { key: "compute", label: "Nodes", kinds: ["compute"] },
  { key: "leaf", label: "Switches", kinds: ["leaf", "spine"] },
  { key: "power", label: "Power shelves", kinds: ["power"] },
];

function RackTree({
  rack,
  kids,
  opened,
  openGroups,
  focus,
  onToggleRack,
  onToggleGroup,
  onOpen,
}: {
  rack: ProvisionRack;
  kids: InventoryNode[];
  opened: boolean;
  openGroups: Record<string, boolean>;
  focus: string | null;
  onToggleRack: () => void;
  onToggleGroup: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      <tr className="inv-parent" onClick={onToggleRack}>
        <td>
          <span className="inv-tri" data-open={opened ? "true" : undefined} />
          <b>{rack.name}</b>
          <em>{rack.serial}</em>
        </td>
        <td>{rack.status}</td>
      </tr>
      {opened
        ? GROUPS.map((g) => {
            const items = kids.filter((n) => g.kinds.includes(n.kind));
            if (!items.length) return null;
            const gid = `${rack.id}:${g.key}`;
            const gopen = openGroups[gid] ?? g.key === "compute";
            return (
              <GroupRows
                key={gid}
                gid={gid}
                label={g.label}
                count={items.length}
                opened={gopen}
                items={items}
                focus={focus}
                onToggle={() => onToggleGroup(gid)}
                onOpen={onOpen}
              />
            );
          })
        : null}
    </>
  );
}

function GroupRows({
  gid,
  label,
  count,
  opened,
  items,
  focus,
  onToggle,
  onOpen,
}: {
  gid: string;
  label: string;
  count: number;
  opened: boolean;
  items: InventoryNode[];
  focus: string | null;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  void gid;
  return (
    <>
      <tr className="inv-group" onClick={onToggle}>
        <td>
          <span className="inv-indent" />
          <span className="inv-tri" data-open={opened ? "true" : undefined} />
          {label}
          <em>{count}</em>
        </td>
        <td />
      </tr>
      {opened
        ? [...items]
            .sort((a, b) => {
              const ia = slotIndex(a.name);
              const ib = slotIndex(b.name);
              if (ia !== ib) return ia - ib;
              return a.name.localeCompare(b.name, undefined, { numeric: true });
            })
            .map((n) => (
            <tr
              key={n.id}
              className="inv-row inv-leaf"
              data-sel={focus === n.id ? "true" : undefined}
              onClick={() => onOpen(n.id)}
            >
              <td>
                <span className="inv-indent" />
                <span className="inv-indent" />
                {n.name}
              </td>
              <td className={`status-${n.provision_status}`}>{n.provision_status}</td>
            </tr>
          ))
        : null}
    </>
  );
}
