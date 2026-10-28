"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { InventoryNode } from "@/lib/cluster";
import type { PickedNode } from "@/components/PodPowerBoard";

import "../app/(app)/provision/provision.css";

type Jump = "ssh" | "sol" | "kvm" | "bmc";
type SshLine = { id: string; kind: "sys" | "cmd" | "out" | "err"; text: string };
type PxeServer = { id: string; host: string; username: string; password?: string | null };

const SCALE_STEPS = [100, 115, 125, 150, 175, 200];

function same(a?: string | null, b?: string | null) {
  const left = (a || "").trim().toLowerCase();
  const right = (b || "").trim().toLowerCase();
  return Boolean(left && right && left === right);
}

function matchNode(nodes: InventoryNode[], picked: PickedNode) {
  return (
    nodes.find((n) => same(n.bmc_ip, picked.bmcIp)) ||
    nodes.find((n) => same(n.os_ip, picked.osIp)) ||
    nodes.find((n) => same(n.serial, picked.serial)) ||
    nodes.find((n) => same(n.name, picked.hostname))
  );
}

function kvmUrl(launched: { path: string }, kind: "kvm" | "sol" | "bmc") {
  const raw = launched.path.startsWith("http") ? new URL(launched.path).pathname : launched.path;
  const base = raw.replace(/\/?$/, "/");
  const hash = kind === "sol" ? "#/console/serial-over-lan-console" : kind === "bmc" ? "#/" : "#/console/kvm";
  return `${base}?view=${encodeURIComponent(kind)}${hash}`;
}

export function NodeConsole({ picked, onClose }: { picked: PickedNode; onClose: () => void }) {
  const [node, setNode] = useState<InventoryNode | null>(null);
  const [servers, setServers] = useState<PxeServer[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const [sshLines, setSshLines] = useState<SshLine[]>([]);
  const [sshCmd, setSshCmd] = useState("");
  const [sshBusy, setSshBusy] = useState(false);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [scale, setScale] = useState(115);
  const [clipOpen, setClipOpen] = useState(false);
  const [clipText, setClipText] = useState("");
  const [clipNote, setClipNote] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const serversRef = useRef<PxeServer[]>([]);

  const osIp = (node?.os_ip || picked.osIp || "").trim();
  const osUser = (node?.os_username || picked.osUser || "root").trim() || "root";
  const bmcIp = (node?.bmc_ip || picked.bmcIp || "").trim();
  const title = picked.hostname || node?.name || picked.label || `Slot ${picked.index}`;

  useEffect(() => {
    serversRef.current = servers;
  }, [servers]);

  useEffect(() => {
    let stop = false;
    setReady(false);
    setError(null);
    Promise.all([api.provision({ sync: false }), api.provisionPxeServers()])
      .then(([snap, pxe]) => {
        if (stop) return;
        setNode(matchNode(snap.nodes || [], picked) || null);
        setServers(pxe.servers || []);
        setReady(true);
      })
      .catch((err) => {
        if (stop) return;
        setError(err instanceof Error ? err.message : "Could not load this node");
        setReady(true);
      });
    return () => {
      stop = true;
    };
  }, [picked]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sshLines, sshBusy]);

  function sendScale(next = scale) {
    const factor = next / 100;
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
    sendScale();
  }, [scale, viewUrl]);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === "l12-scale-ready") sendScale();
      if (e.data?.type === "l12-clipboard") {
        const text = String(e.data.text || "");
        setClipText(text);
        setClipNote(text ? "Copied from KVM" : "KVM clipboard is empty — copy in the guest first");
        if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [scale]);

  function bumpScale(dir: -1 | 1) {
    const i = SCALE_STEPS.findIndex((s) => s >= scale);
    const cur = i < 0 ? 0 : SCALE_STEPS[i] === scale ? i : Math.max(0, i - 1);
    setScale(SCALE_STEPS[Math.max(0, Math.min(SCALE_STEPS.length - 1, cur + dir))] ?? 115);
  }

  async function ensureHop(target: InventoryNode | null) {
    const assigned = (target?.pxe_server || "").trim().toLowerCase();
    if (assigned && !serversRef.current.some((server) => server.host.trim().toLowerCase() === assigned)) {
      setError(`Save ${target?.pxe_server} as a PXE server in Provision before connecting`);
      return false;
    }
    return true;
  }

  async function openSsh() {
    if (!osIp) {
      setError("This node has no OS IP for SSH");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!(await ensureHop(node))) return;
      setViewUrl(null);
      setJump("ssh");
      setSshCmd("");
      setSshLines([{ id: crypto.randomUUID(), kind: "sys", text: `ssh ${osUser}@${osIp}` }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open SSH");
    } finally {
      setBusy(false);
    }
  }

  async function runSsh(command: string) {
    const cmd = command.trim();
    if (!cmd || sshBusy) return;
    const target = node?.id || osIp;
    setSshCmd("");
    setSshLines((cur) => [...cur, { id: crypto.randomUUID(), kind: "cmd", text: `$ ${cmd}` }]);
    setSshBusy(true);
    try {
      const out = await api.agentConsole(target, cmd, "os");
      setSshLines((cur) => {
        const next = [...cur];
        if (out.via === "hop" && !cur.some((line) => line.text.includes("PXE hop"))) {
          next.push({ id: crypto.randomUUID(), kind: "sys", text: "connected through the PXE hop" });
        }
        if (out.stdout) next.push({ id: crypto.randomUUID(), kind: "out", text: out.stdout });
        if (out.stderr) next.push({ id: crypto.randomUUID(), kind: "err", text: out.stderr });
        if (out.error) next.push({ id: crypto.randomUUID(), kind: "err", text: out.error });
        if (out.exit != null) next.push({ id: crypto.randomUUID(), kind: "sys", text: `exit ${out.exit}` });
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "SSH failed";
      setSshLines((cur) => [...cur, { id: crypto.randomUUID(), kind: "err", text: msg }]);
    } finally {
      setSshBusy(false);
    }
  }

  async function openSession(kind: "kvm" | "sol" | "bmc") {
    if (!node) {
      setError("This node is not in Provision yet");
      return;
    }
    if (!bmcIp) {
      setError("This node has no BMC IP");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!(await ensureHop(node))) return;
      const launched = await api.provisionKvm(node.id, kind);
      setJump(kind);
      setViewUrl(kvmUrl(launched, kind));
      setClipOpen(false);
      setClipNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : kind === "kvm" ? "KVM failed" : "SOL failed");
    } finally {
      setBusy(false);
    }
  }

  function postIframe(payload: Record<string, unknown>) {
    try {
      iframeRef.current?.contentWindow?.postMessage(payload, "*");
    } catch {
      /* ignore */
    }
  }

  return (
    <aside className="node-console" aria-label="Node console" onPointerDown={(e) => e.stopPropagation()}>
      <header className="rack-panel-head">
        <nav className="rack-panel-tabs">
          <button type="button" data-active="true">
            Console
          </button>
        </nav>
        <div className="node-console-zoom" role="group" aria-label="Console font">
          <button type="button" className="btn" disabled={scale <= 100} onClick={() => bumpScale(-1)}>
            A−
          </button>
          <span>{scale}%</span>
          <button type="button" className="btn" disabled={scale >= 200} onClick={() => bumpScale(1)}>
            A+
          </button>
          {viewUrl ? (
            <button type="button" className="btn" aria-pressed={clipOpen} onClick={() => setClipOpen((v) => !v)}>
              Clipboard
            </button>
          ) : null}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close console">
          ×
        </button>
      </header>
      <div className="node-console-body">
        <div className="node-console-title">
          <strong>{title}</strong>
          <span>
            {osIp ? `OS ${osIp}` : "No OS IP"}
            {bmcIp ? ` · BMC ${bmcIp}` : ""}
          </span>
        </div>
        <div className="provision-sol-bar node-console-bar">
          <button
            type="button"
            className={jump === "ssh" ? "btn btn-primary" : "btn"}
            data-active={jump === "ssh" ? "true" : undefined}
            disabled={!ready || busy || !osIp}
            onClick={() => void openSsh()}
          >
            SSH
          </button>
          <button
            type="button"
            className={jump === "sol" ? "btn btn-primary" : "btn"}
            data-active={jump === "sol" ? "true" : undefined}
            disabled={!ready || busy || !bmcIp || !node}
            onClick={() => void openSession("sol")}
          >
            Live SOL
          </button>
          <button
            type="button"
            className={jump === "kvm" ? "btn btn-primary" : "btn"}
            data-active={jump === "kvm" ? "true" : undefined}
            disabled={!ready || busy || !bmcIp || !node}
            onClick={() => void openSession("kvm")}
          >
            Open KVM
          </button>
          <button
            type="button"
            className={jump === "bmc" ? "btn btn-primary" : "btn"}
            data-active={jump === "bmc" ? "true" : undefined}
            disabled={!ready || busy || !bmcIp || !node}
            onClick={() => void openSession("bmc")}
          >
            Access BMC
          </button>
        </div>
        {error ? <p className="cluster-error">{error}</p> : null}
        {jump === "ssh" ? (
          <div className="provision-ssh">
            <div className="provision-ssh-log" ref={logRef} style={{ fontSize: `calc(0.78rem * ${scale / 100})` }}>
              {sshLines.map((line) => (
                <pre key={line.id} data-kind={line.kind}>
                  {line.text}
                </pre>
              ))}
              {sshBusy ? <p>working…</p> : null}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runSsh(sshCmd);
              }}
            >
              <input
                value={sshCmd}
                onChange={(e) => setSshCmd(e.target.value)}
                placeholder="command…"
                aria-label="SSH command"
                autoComplete="off"
                spellCheck={false}
                disabled={sshBusy}
              />
              <button type="submit" className="btn btn-primary" disabled={sshBusy || !sshCmd.trim()}>
                Run
              </button>
            </form>
          </div>
        ) : viewUrl ? (
          <div className="provision-kvm-frame">
            {clipOpen ? (
              <div className="provision-clip">
                <textarea
                  value={clipText}
                  onChange={(e) => setClipText(e.target.value)}
                  placeholder="Paste here, then send to KVM"
                  rows={3}
                />
                <div className="provision-clip-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      postIframe({ type: "l12-clipboard-paste", text: clipText });
                      setClipNote("Sent to KVM — Ctrl+V in the guest if it does not appear");
                    }}
                  >
                    Paste to KVM
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      postIframe({ type: "l12-clipboard-request" });
                      setClipNote("Waiting for KVM clipboard…");
                    }}
                  >
                    Copy from KVM
                  </button>
                  {clipNote ? <small>{clipNote}</small> : null}
                </div>
              </div>
            ) : null}
            <iframe ref={iframeRef} title={`${jump} ${title}`} src={viewUrl} onLoad={() => sendScale()} />
          </div>
        ) : (
          <pre className="console node-console-idle" style={{ fontSize: `calc(0.78rem * ${scale / 100})` }}>
            {ready ? "Pick SSH, Live SOL, Open KVM, or Access BMC." : "Loading node…"}
          </pre>
        )}
      </div>
    </aside>
  );
}
