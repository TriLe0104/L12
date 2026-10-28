"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ThemeDialog } from "@/components/ThemeDialog";
import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type { InventoryNode, ProvisionRack, ProvisionSnapshot } from "@/lib/cluster";

import "../cluster/cluster.css";
import "./provision.css";

type GroupKey = "compute" | "leaf" | "power";

type PxeServer = {
  id: string;
  name: string;
  host: string;
  username: string;
  password: string;
  reachability: "unknown" | "checking" | "reachable" | "auth-failed" | "offline";
  detail?: string;
};

type NodeDraft = {
  name: string;
  serial: string;
  hall_name: string;
  pxe_server: string;
  bmc_mac: string;
  bmc_ip: string;
  bmc_user: string;
  bmc_password: string;
  os_ip: string;
  os_username: string;
  os_password: string;
};

const DRAFT_KEYS: (keyof NodeDraft)[] = [
  "name",
  "serial",
  "hall_name",
  "pxe_server",
  "bmc_mac",
  "bmc_ip",
  "bmc_user",
  "bmc_password",
  "os_ip",
  "os_username",
  "os_password",
];

function solIsStub(log: string | null | undefined): boolean {
  const text = (log || "").trim();
  if (!text) return true;
  if (text.includes("RedfishVersion") || text.includes("=== Redfish")) return false;
  if (text.includes("login: ubuntu") || text.includes("provision complete")) return false;
  if (
    text.includes("No BMC IP on this node yet.") ||
    text.includes("Connect SSH to") ||
    text.includes("PXE hop dropped") ||
    text.includes("SOL capture failed") ||
    text.includes("SOL idle")
  ) {
    return true;
  }
  return text.length < 40;
}

function nodeNeedsFill(node: InventoryNode): boolean {
  if ((node.source || "demo") === "demo") return false;
  if (node.bmc_mac && !node.bmc_ip) return true;
  if (node.bmc_ip && !node.bmc_mac) return true;
  const serial = (node.serial || "").toUpperCase();
  const placeholder = !serial || serial.startsWith("MAC-") || serial.startsWith("IP-") || serial.startsWith("UNK-");
  if (node.bmc_ip && node.bmc_password && placeholder) return true;
  if (node.kind === "compute" && node.bmc_ip && node.bmc_password && solIsStub(node.sol_log)) return true;
  return false;
}

function draftFrom(node: InventoryNode): NodeDraft {
  return {
    name: node.name || "",
    serial: node.serial || "",
    hall_name: node.hall_name || node.name || "",
    pxe_server: node.pxe_server || "",
    bmc_mac: node.bmc_mac || "",
    bmc_ip: node.bmc_ip || "",
    bmc_user: node.bmc_user || "ADMIN",
    bmc_password: node.bmc_password || "",
    os_ip: node.os_ip || "",
    os_username: node.os_username || "",
    os_password: node.os_password || "",
  };
}

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
  const [hopName, setHopName] = useState("");
  const [pxeServers, setPxeServers] = useState<PxeServer[]>([]);
  const [activePxeId, setActivePxeId] = useState<string | null>(null);
  const [pxeServersReady, setPxeServersReady] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeRack, setRemoveRack] = useState<ProvisionRack | null>(null);
  const [addMac, setAddMac] = useState("");
  const [addBmcUser, setAddBmcUser] = useState("ADMIN");
  const [addBmcPass, setAddBmcPass] = useState("");
  const [addBmcIp, setAddBmcIp] = useState("");
  const [addOsIp, setAddOsIp] = useState("");
  const [addOsUser, setAddOsUser] = useState("root");
  const [addOsPass, setAddOsPass] = useState("");
  const [addSerial, setAddSerial] = useState("");
  const [addHall, setAddHall] = useState("");
  const [addPxeServer, setAddPxeServer] = useState("");
  const [addNote, setAddNote] = useState("");
  const [draft, setDraft] = useState<NodeDraft | null>(null);
  const [log, setLog] = useState("");
  const [openRacks, setOpenRacks] = useState<Record<string, boolean>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [kvm, setKvm] = useState<{ url: string; name: string; user: string; kind: "kvm" | "sol" | "bmc" } | null>(null);
  const [sshOn, setSshOn] = useState(false);
  const [sshLines, setSshLines] = useState<{ id: string; kind: "sys" | "cmd" | "out" | "err"; text: string }[]>([]);
  const [sshCmd, setSshCmd] = useState("");
  const [sshBusy, setSshBusy] = useState(false);
  const sshLogRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [portalScale, setPortalScale] = useState(150);
  const [expanded, setExpanded] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [clipText, setClipText] = useState("");
  const [clipNote, setClipNote] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pxeServersRef = useRef<PxeServer[]>([]);
  const pxeLoadedOk = useRef(false);

  const pxeIdentity = pxeServers.map((server) => [server.id, server.name, server.host, server.username, server.password].join("\u001f")).join("\n");

  useEffect(() => {
    let cancel = false;
    (async () => {
      let local: PxeServer[] = [];
      try {
        const raw = window.sessionStorage.getItem("l12-provision-pxe-servers");
        if (raw) {
          const saved = JSON.parse(raw) as PxeServer[];
          if (Array.isArray(saved)) {
            local = saved
              .filter((server) => server && server.host && server.username)
              .map((server) => ({
                ...server,
                id: server.id || crypto.randomUUID(),
                reachability: "unknown" as const,
                detail: undefined,
              }));
          }
        }
        if (!cancel) setActivePxeId(window.sessionStorage.getItem("l12-provision-active-pxe"));
      } catch (err) {
        if (!cancel) setError(err instanceof Error ? err.message : "Could not load saved PXE server profiles");
      }
      try {
        const remote = await api.provisionPxeServers();
        if (cancel) return;
        pxeLoadedOk.current = true;
        if (remote.servers.length) {
          setPxeServers(
            remote.servers.map((server) => ({
              id: server.id,
              name: server.name,
              host: server.host,
              username: server.username,
              password: server.password || "",
              reachability: "unknown",
            })),
          );
        } else if (local.length) {
          setPxeServers(local);
        }
      } catch (err) {
        if (cancel) return;
        if (local.length) setPxeServers(local);
        setError(err instanceof Error ? err.message : "Could not load PXE servers");
      } finally {
        if (!cancel) setPxeServersReady(true);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    pxeServersRef.current = pxeServers;
    if (!pxeServersReady) return;
    try {
      window.sessionStorage.setItem(
        "l12-provision-pxe-servers",
        JSON.stringify(
          pxeServers.map(({ id, name, host, username, password }) => ({ id, name, host, username, password })),
        ),
      );
      if (activePxeId) window.sessionStorage.setItem("l12-provision-active-pxe", activePxeId);
      else window.sessionStorage.removeItem("l12-provision-active-pxe");
    } catch {
      setError("Could not save PXE server profiles in this browser");
    }
  }, [pxeServers, activePxeId, pxeServersReady]);

  useEffect(() => {
    if (!pxeServersReady || !mayEdit || !pxeLoadedOk.current) return;
    const servers = pxeServersRef.current.map(({ id, name, host, username, password }) => ({
      id,
      name,
      host,
      username,
      password,
    }));
    let ignore = false;
    api.provisionSavePxeServers(servers).catch((err) => {
      if (!ignore) setError(err instanceof Error ? err.message : "Could not save PXE servers");
    });
    return () => {
      ignore = true;
    };
  }, [pxeServersReady, mayEdit, pxeIdentity]);

  const checkPxeServer = useCallback(async (server: PxeServer) => {
    setPxeServers((current) =>
      current.map((entry) =>
        entry.id === server.id ? { ...entry, reachability: "checking", detail: undefined } : entry,
      ),
    );
    try {
      const result = await api.provisionHopCheck({
        host: server.host,
        username: server.username,
        password: server.password || undefined,
      });
      setPxeServers((current) =>
        current.map((entry) =>
          entry.id === server.id
            ? {
                ...entry,
                reachability: result.authenticated ? "reachable" : result.reachable ? "auth-failed" : "offline",
                detail: result.detail,
              }
            : entry,
        ),
      );
    } catch {
      setPxeServers((current) =>
        current.map((entry) =>
          entry.id === server.id ? { ...entry, reachability: "offline", detail: "Status check failed" } : entry,
        ),
      );
    }
  }, []);

  useEffect(() => {
    if (!pxeServersReady || !mayEdit) return;
    const checkAll = () => pxeServersRef.current.forEach((server) => void checkPxeServer(server));
    checkAll();
    const timer = window.setInterval(checkAll, 30_000);
    return () => window.clearInterval(timer);
  }, [pxeServersReady, mayEdit, checkPxeServer]);

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
    return `${base}?view=${encodeURIComponent(kind)}${hash}`;
  }

  useEffect(() => {
    const el = sshLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sshLines, sshBusy]);

  async function ensureNodePxeHop(node: InventoryNode): Promise<boolean> {
    const assigned = (node.pxe_server || "").trim().toLowerCase();
    if (assigned && !pxeServers.some((server) => server.host.trim().toLowerCase() === assigned)) {
      setError(`Save ${node.pxe_server} as a PXE server in this tab before connecting`);
      return false;
    }
    return true;
  }

  async function openSsh() {
    if (!focused) return;
    const host = (focused.os_ip || "").trim();
    const user = (focused.os_username || "root").trim() || "root";
    if (!host) {
      const what = focused.kind === "power" ? "power shelf" : sshOnly(focused.kind) ? "switch" : "node";
      setError(`This ${what} has no OS IP for SSH`);
      return;
    }
    if (!(await ensureNodePxeHop(focused))) return;
    setKvm(null);
    setSshOn(true);
    setDetailsOpen(false);
    setSshCmd("");
    setSshLines([{ id: crypto.randomUUID(), kind: "sys", text: `ssh ${user}@${host}` }]);
  }

  async function runSsh(command: string) {
    if (!focused || sshBusy) return;
    const cmd = command.trim();
    if (!cmd) return;
    const node = sshOnly(focused.kind) ? focused.id : (focused.os_ip || focused.name || "").trim();
    setSshCmd("");
    setSshLines((cur) => [...cur, { id: crypto.randomUUID(), kind: "cmd", text: `$ ${cmd}` }]);
    setSshBusy(true);
    try {
      const out = await api.agentConsole(node, cmd, sshOnly(focused.kind) ? "os" : undefined);
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
    if (!focused) return;
    if (!(await ensureNodePxeHop(focused))) return;
    setBusy(true);
    try {
      const launched = await api.provisionKvm(focused.id, kind);
      setSshOn(false);
      setKvm({ url: kvmUrl(launched, kind), name: focused.name, user: launched.user || "ADMIN", kind });
      setClipOpen(false);
      setClipNote("");
      setDetailsOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : kind === "kvm" ? "KVM failed" : "SOL failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(async () => {
    const snap = await api.provision();
    setData(snap);
    if (snap.hop?.host) setHopHost(snap.hop.host);
    if (snap.hop?.connected && snap.hop?.user) setHopUser(snap.hop.user);
    if (snap.hop?.connected && snap.hop?.host) {
      const active = pxeServersRef.current.find((server) => server.host === snap.hop?.host);
      if (active) setActivePxeId(active.id);
    }
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load inventory"));
  }, [load]);

  useEffect(() => {
    if (!data?.hop?.connected || !data.hop.host) return;
    const active = pxeServers.find((server) => server.host === data.hop?.host);
    if (active && active.id !== activePxeId) setActivePxeId(active.id);
  }, [data?.hop?.connected, data?.hop?.host, pxeServers, activePxeId]);

  const pendingFocus = useRef<string[] | null>(null);

  const selectByNeedles = useCallback(
    (needles: string[], list: InventoryNode[] | undefined) => {
      const want = needles.map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!want.length || !list?.length) return false;
      const hit = list.find((n) =>
        want.some((w) =>
          [n.id, n.name, n.serial, n.bmc_ip, n.os_ip].some((v) => (v || "").trim().toLowerCase() === w),
        ),
      );
      if (!hit) return false;
      setFocus(hit.id);
      setKvm(null);
      setDetailsOpen(false);
      pendingFocus.current = null;
      return true;
    },
    [],
  );

  useEffect(() => {
    const onRefresh = () => {
      load().catch(() => undefined);
    };
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent<{ ids?: string[]; target?: string }>).detail || {};
      const ids = [...(detail.ids || []), detail.target || ""].map(String).filter(Boolean);
      pendingFocus.current = ids;
      selectByNeedles(ids, data?.nodes);
    };
    window.addEventListener("l12-refresh", onRefresh);
    window.addEventListener("l12-focus-node", onFocus as EventListener);
    return () => {
      window.removeEventListener("l12-refresh", onRefresh);
      window.removeEventListener("l12-focus-node", onFocus as EventListener);
    };
  }, [load, data, selectByNeedles]);

  useEffect(() => {
    if (pendingFocus.current) selectByNeedles(pendingFocus.current, data?.nodes);
  }, [data, selectByNeedles]);

  const focused: InventoryNode | undefined = data?.nodes.find((n) => n.id === focus);
  const serverDraft = useRef<NodeDraft | null>(null);
  const seenFocus = useRef<string | null>(null);

  useEffect(() => {
    if (!focused) {
      seenFocus.current = null;
      serverDraft.current = null;
      setDraft(null);
      setLog("");
      return;
    }
    const incoming = draftFrom(focused);
    if (seenFocus.current !== focused.id) {
      seenFocus.current = focused.id;
      setSshOn(false);
      setSshLines([]);
      setKvm(null);
      serverDraft.current = incoming;
      setDraft(incoming);
      setLog(focused.sol_log || "");
      return;
    }
    const prev = serverDraft.current;
    setDraft((cur) => {
      if (!cur || !prev) return incoming;
      let changed = false;
      const next = { ...cur };
      for (const key of DRAFT_KEYS) {
        if ((cur[key] || "") === (prev[key] || "") && (cur[key] || "") !== (incoming[key] || "")) {
          next[key] = incoming[key];
          changed = true;
        }
      }
      return changed ? next : cur;
    });
    serverDraft.current = incoming;
    setLog(focused.sol_log || "");
  }, [focused]);

  const waitingOnFill = Boolean(data?.hop?.connected && data?.nodes.some(nodeNeedsFill));

  useEffect(() => {
    if (!waitingOnFill) return;
    let stop = false;
    let inflight = false;
    const id = window.setInterval(() => {
      if (stop || inflight) return;
      inflight = true;
      api
        .provision({ sync: false })
        .then((snap) => {
          if (!stop) setData(snap);
        })
        .catch(() => undefined)
        .finally(() => {
          inflight = false;
        });
    }, 4000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [waitingOnFill]);

  const filtered = useMemo(() => {
    const list = data?.nodes ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((n) =>
      `${n.name} ${n.serial} ${n.bmc_mac} ${n.bmc_ip} ${n.os_ip} ${n.hall_name}`.toLowerCase().includes(needle),
    );
  }, [data, q]);

  const dirty =
    Boolean(focused && draft) && DRAFT_KEYS.some((k) => (draft?.[k] || "") !== (focused ? draftFrom(focused)[k] : ""));

  function setDraftField(key: keyof NodeDraft, value: string) {
    setDraft((cur) => (cur ? { ...cur, [key]: value } : cur));
  }

  async function saveNode() {
    if (!focused || !draft) return;
    const payload: Record<string, string> = {};
    const orig = draftFrom(focused);
    for (const key of DRAFT_KEYS) {
      if (draft[key] !== orig[key]) payload[key] = draft[key];
    }
    if (!Object.keys(payload).length) return;
    setBusy(true);
    try {
      const out = await api.provisionPatchNode(focused.id, payload);
      setData(out);
      if (out.added) setDraft(draftFrom(out.added));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
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

  function addPxeProfile() {
    const host = hopHost.trim();
    if (!host) {
      setError("PXE server IP is required");
      return;
    }
    if (pxeServers.some((server) => server.host.toLowerCase() === host.toLowerCase())) {
      setError(`PXE server ${host} is already saved`);
      return;
    }
    const server: PxeServer = {
      id: crypto.randomUUID(),
      name: hopName.trim() || host,
      host,
      username: hopUser.trim() || "root",
      password: hopPass,
      reachability: "unknown",
    };
    setPxeServers((current) => [...current, server]);
    setHopName("");
    setHopPass("");
    setError(null);
    void checkPxeServer(server);
  }

  async function connectPxeProfile(server: PxeServer) {
    setBusy(true);
    try {
      const hop = await api.provisionHopConnect({
        host: server.host,
        username: server.username,
        password: server.password || undefined,
      });
      setActivePxeId(server.id);
      setPxeServers((current) =>
        current.map((entry) =>
          entry.id === server.id
            ? { ...entry, reachability: "reachable", detail: "SSH login accepted" }
            : entry,
        ),
      );
      setHopOpen(false);
      await load();
      if (!hop.connected) setError(`SSH session to ${server.host} did not stay connected`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not connect to ${server.host}`);
      void checkPxeServer(server);
    } finally {
      setBusy(false);
    }
  }

  async function removePxeProfile(server: PxeServer) {
    if (server.id === activePxeId && data?.hop?.connected) {
      setBusy(true);
      try {
        await api.provisionHopClose();
        setData((current) =>
          current ? { ...current, hop: current.hop ? { ...current.hop, connected: false } : current.hop } : current,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not close the active PXE connection");
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setPxeServers((current) => current.filter((entry) => entry.id !== server.id));
    if (server.id === activePxeId) setActivePxeId(null);
  }

  const racks = data?.racks?.length
    ? data.racks
    : data?.nodes?.length
      ? ([
          {
            id: "inventory",
            serial: "",
            name: "Inventory",
            type: "",
            status: "",
            counts: { nodes: filtered.length, switches: 0, shelves: 0 },
          },
        ] as ProvisionRack[])
      : [];

  return (
    <div className="cluster-app provision-app" data-mona="provision">
      <div className="cluster-toolbar">
        <div className="cluster-tabs">
          <span className="cluster-kicker">Provision</span>
        </div>
        <div className="cluster-tools">
          <input className="field" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
          {mayEdit && (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setAddNote("");
                    const snap = await api.provisionSync();
                    if (snap.sync_errors?.length) {
                      setError(`Argus sync incomplete: ${snap.sync_errors.join("; ")}`);
                    }
                    return snap;
                  })
                }
              >
                Sync Argus
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => {
                  setAddNote("");
                  setAddOpen(true);
                }}
              >
                Add node
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setHopOpen(true)}>
                {data?.hop?.hosts && data.hop.hosts.length > 1
                  ? `PXE · ${data.hop.hosts.length}`
                  : data?.hop?.connected
                    ? `PXE · ${data.hop.host}`
                    : `PXE servers · ${pxeServers.length}`}
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
      {addNote && !addOpen ? <p className="widget-meta">{addNote}</p> : null}
      <div className="provision-body">
        <div className="provision-col">
          <div className="network-count">
            {data
              ? data.nodes.length
                ? `${data.source === "argus" ? "Argus · " : data.source === "manual" ? "Manual · " : ""}${data.summary.compute} nodes · ${data.summary.switches} switches · ${data.summary.shelves ?? 0} PS`
                : data.racks?.some((rack) => rack.type === "placeholder")
                  ? `${data.racks.find((rack) => rack.type === "placeholder")?.counts.nodes ?? 0} placeholder racks`
                  : "No racks"
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
                {racks.length === 0 && data ? (
                  <tr>
                    <td colSpan={2}>
                      No racks in L12. Sync Argus reads the PXE controllers.
                    </td>
                  </tr>
                ) : null}
                {racks.map((rack) => {
                  const kids = filtered.filter((n) => {
                    if (!data?.racks?.length) return true;
                    const want = (rack.name || rack.id || "").trim().toLowerCase();
                    const got = (n.hall_name || n.name || "").trim().toLowerCase();
                    return got === want || n.rack_id === rack.id || n.hall_name === rack.name;
                  });
                  const opened = openRacks[rack.id] ?? true;
                  return (
                    <RackTree
                      key={rack.id}
                      rack={rack}
                      kids={kids}
                      pxeServers={pxeServers}
                      opened={opened}
                      openGroups={openGroups}
                      focus={focus}
                      mayEdit={mayEdit}
                      onToggleRack={() => setOpenRacks((c) => ({ ...c, [rack.id]: !opened }))}
                      onToggleGroup={(g) => setOpenGroups((c) => ({ ...c, [g]: !(c[g] ?? g.endsWith(":compute")) }))}
                      onOpen={(id) => {
                        setFocus(id);
                        setKvm(null);
                        setDetailsOpen(false);
                      }}
                      onRemove={() => setRemoveRack(rack)}
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
              <span>Add one by BMC IP or MAC, plus BMC id and password. Missing MAC, IP, serial, and SOL fill in the background once the PXE hop is up.</span>
              {mayEdit ? (
                <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
                  Add node
                </button>
              ) : null}
            </div>
          ) : (
            <div
              className="provision-sol"
              data-session={kvm || sshOn ? "true" : undefined}
              style={{ ["--kvm-scale" as string]: String(portalScale / 100) }}
            >
              <header className="provision-pane-head">
                <div>
                  <p className="maxlps-kicker">{kindLabel(focused.kind)}</p>
                  <h2>{draft?.name || focused.name}</h2>
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
                data-ssh-only={sshOnly(focused.kind) ? "true" : undefined}
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((v) => !v)}
              >
                <i data-open={detailsOpen ? "true" : undefined} aria-hidden />
                {sshOnly(focused.kind) ? null : (
                  <span>
                    <b>BMC</b> {(draft?.bmc_user ?? focused.bmc_user) || "—"} / {(draft?.bmc_password ?? focused.bmc_password) || "—"}
                    <small>{(draft?.bmc_ip ?? focused.bmc_ip) || "no IP"}</small>
                  </span>
                )}
                <span>
                  <b>OS</b> {(draft?.os_username ?? focused.os_username) || "—"} / {(draft?.os_password ?? focused.os_password) || "—"}
                  <small>{(draft?.os_ip ?? focused.os_ip) || "no IP"}</small>
                </span>
              </button>
              {detailsOpen ? (
                mayEdit && draft ? (
                  <form
                    className="prov-dl prov-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveNode();
                    }}
                  >
                    <label>
                      Name
                      <input className="field" value={draft.name} onChange={(e) => setDraftField("name", e.target.value)} />
                    </label>
                    <label>
                      Serial
                      <input className="field" value={draft.serial} onChange={(e) => setDraftField("serial", e.target.value)} />
                    </label>
                    <label>
                      BMC IP
                      <input className="field" value={draft.bmc_ip} onChange={(e) => setDraftField("bmc_ip", e.target.value)} />
                    </label>
                    <label>
                      BMC MAC
                      <input className="field" value={draft.bmc_mac} onChange={(e) => setDraftField("bmc_mac", e.target.value)} placeholder="optional" />
                    </label>
                    <label>
                      BMC id
                      <input className="field" value={draft.bmc_user} onChange={(e) => setDraftField("bmc_user", e.target.value)} autoComplete="off" />
                    </label>
                    <label>
                      BMC password
                      <input className="field" type="password" value={draft.bmc_password} onChange={(e) => setDraftField("bmc_password", e.target.value)} autoComplete="new-password" />
                    </label>
                    <label>
                      OS IP
                      <input className="field" value={draft.os_ip} onChange={(e) => setDraftField("os_ip", e.target.value)} />
                    </label>
                    <label>
                      Rack
                      <input
                        className="field"
                        value={draft.hall_name}
                        onChange={(e) => setDraftField("hall_name", e.target.value)}
                        placeholder="same name groups nodes"
                      />
                    </label>
                    <label>
                      PXE server
                      <select
                        className="field"
                        value={draft.pxe_server}
                        onChange={(e) => setDraftField("pxe_server", e.target.value)}
                      >
                        <option value="">Unassigned</option>
                        {draft.pxe_server && !pxeServers.some((server) => server.host === draft.pxe_server) ? (
                          <option value={draft.pxe_server}>{draft.pxe_server} · not saved in this tab</option>
                        ) : null}
                        {pxeServers.map((server) => (
                          <option key={server.id} value={server.host}>
                            {server.name} · {server.host}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      OS login
                      <input className="field" value={draft.os_username} onChange={(e) => setDraftField("os_username", e.target.value)} autoComplete="off" />
                    </label>
                    <label>
                      OS password
                      <input className="field" type="password" value={draft.os_password} onChange={(e) => setDraftField("os_password", e.target.value)} autoComplete="new-password" />
                    </label>
                    <div className="prov-edit-status">
                      <span>Status</span>
                      <b>{focused.provision_status}</b>
                    </div>
                    <div className="prov-edit-actions">
                      <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
                        Save
                      </button>
                    </div>
                  </form>
                ) : (
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
                )
              ) : null}
              {mayEdit && (
                <div className="provision-sol-bar">
                  <button
                    type="button"
                    className={sshOn && !kvm ? "btn btn-primary" : "btn"}
                    data-active={sshOn && !kvm ? "true" : undefined}
                    disabled={busy || !focused.os_ip}
                    onClick={openSsh}
                  >
                    SSH
                  </button>
                  {focused.kind === "compute" && (
                    <>
                      <button
                        type="button"
                        className={kvm?.kind === "sol" ? "btn btn-primary" : "btn"}
                        data-active={kvm?.kind === "sol" ? "true" : undefined}
                        disabled={busy || !focused.bmc_ip}
                        onClick={() => void openSession("sol")}
                      >
                        Live SOL
                      </button>
                      <button
                        type="button"
                        className={kvm?.kind === "kvm" ? "btn btn-primary" : "btn"}
                        data-active={kvm?.kind === "kvm" ? "true" : undefined}
                        disabled={busy || !focused.bmc_ip}
                        onClick={() => void openSession("kvm")}
                      >
                        Open KVM
                      </button>
                      <button
                        type="button"
                        className={kvm?.kind === "bmc" ? "btn btn-primary" : "btn"}
                        data-active={kvm?.kind === "bmc" ? "true" : undefined}
                        disabled={busy || !focused.bmc_ip}
                        onClick={() => void openSession("bmc")}
                      >
                        Access BMC
                      </button>
                    </>
                  )}
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
                sshOn ? (
                <div className="provision-ssh">
                  <div className="provision-ssh-log" ref={sshLogRef} style={{ fontSize: `calc(0.78rem * ${portalScale / 100})` }}>
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
              ) : (
                <pre className="console" style={{ fontSize: `calc(0.78rem * ${portalScale / 100})` }}>
                  {log || focused.sol_log || (sshOnly(focused.kind) ? "SSH idle." : "SOL idle.")}
                </pre>
              )
              )}
            </div>
          )}
        </aside>
      </div>
      {addOpen && (
        <ThemeDialog
          title="Add node"
          confirmLabel="Add node"
          busy={busy}
          onClose={() => setAddOpen(false)}
          onConfirm={async () => {
            if (!addMac.trim() && !addBmcIp.trim()) {
              setAddNote("BMC IP or BMC MAC is required");
              return;
            }
            setBusy(true);
            try {
              const out = await api.provisionAddNode({
                bmc_mac: addMac.trim() || undefined,
                bmc_user: addBmcUser.trim() || "ADMIN",
                bmc_password: addBmcPass || undefined,
                bmc_ip: addBmcIp.trim() || undefined,
                os_ip: addOsIp.trim() || undefined,
                os_username: addOsUser.trim() || undefined,
                os_password: addOsPass || undefined,
                pxe_server: addPxeServer || undefined,
                serial: addSerial.trim() || undefined,
                hall_name: addHall.trim() || undefined,
              });
              setData(out);
              setFocus(out.added?.id || null);
              setKvm(null);
              setDetailsOpen(false);
              const notes = Array.isArray(out.filled?.notes) ? out.filled.notes.map(String) : [];
              if (!out.created && out.added) {
                notes.unshift(`Updated existing ${out.added.name || out.added.serial}`);
              }
              setAddMac("");
              setAddBmcPass("");
              setAddBmcIp("");
              setAddOsIp("");
              setAddOsPass("");
              setAddSerial("");
              setAddHall("");
              setAddPxeServer("");
              setAddOpen(false);
              if (notes.length) setAddNote(notes.join(" · "));
            } catch (err) {
              setAddNote(err instanceof Error ? err.message : "Add node failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="widget-meta" style={{ margin: "0 0 0.6rem" }}>
            BMC IP, id, and password are enough for KVM. MAC is optional — filled from ARP on the PXE hop and from Redfish. Serial fills the same way.
          </p>
          <div className="provision-add-grid">
            <div>
              <label className="field-label">
                BMC IP
                <input className="field" value={addBmcIp} onChange={(e) => setAddBmcIp(e.target.value)} placeholder="10.10.1.20" autoComplete="off" />
              </label>
              <label className="field-label">
                BMC MAC
                <input className="field" value={addMac} onChange={(e) => setAddMac(e.target.value)} placeholder="optional — auto from IP" autoComplete="off" />
              </label>
              <label className="field-label">
                BMC id
                <input className="field" value={addBmcUser} onChange={(e) => setAddBmcUser(e.target.value)} placeholder="ADMIN" autoComplete="username" />
              </label>
              <label className="field-label">
                BMC password
                <input className="field" type="password" value={addBmcPass} onChange={(e) => setAddBmcPass(e.target.value)} autoComplete="new-password" />
              </label>
            </div>
            <div>
              <label className="field-label">
                Rack name
                <input
                  className="field"
                  value={addHall}
                  onChange={(e) => setAddHall(e.target.value)}
                  placeholder="optional — node becomes its own rack"
                  autoComplete="off"
                />
              </label>
              <label className="field-label">
                PXE server
                <select className="field" value={addPxeServer} onChange={(e) => setAddPxeServer(e.target.value)}>
                  <option value="">Unassigned</option>
                  {pxeServers.map((server) => (
                    <option key={server.id} value={server.host}>
                      {server.name} · {server.host}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Node SN
                <input className="field" value={addSerial} onChange={(e) => setAddSerial(e.target.value)} placeholder="optional — Redfish fills this" autoComplete="off" />
              </label>
              <label className="field-label">
                OS IP
                <input className="field" value={addOsIp} onChange={(e) => setAddOsIp(e.target.value)} placeholder="optional" autoComplete="off" />
              </label>
              <label className="field-label">
                OS login
                <input className="field" value={addOsUser} onChange={(e) => setAddOsUser(e.target.value)} placeholder="root" autoComplete="off" />
              </label>
              <label className="field-label">
                OS password
                <input className="field" type="password" value={addOsPass} onChange={(e) => setAddOsPass(e.target.value)} autoComplete="new-password" />
              </label>
            </div>
          </div>
          {addNote ? <p className="cluster-error">{addNote}</p> : null}
        </ThemeDialog>
      )}
      {hopOpen && (
        <ThemeDialog
          title="PXE servers"
          confirmLabel="Done"
          onClose={() => setHopOpen(false)}
          onConfirm={() => setHopOpen(false)}
        >
          <p className="widget-meta" style={{ margin: "0 0 0.6rem" }}>
            Argus sync reads every saved PXE server and tags each rack with the server it came from. Connect a server to use it as the SSH hop.
          </p>
          <div className="provision-pxe-list">
            {pxeServers.length ? (
              pxeServers.map((server) => (
                <div className="provision-pxe-row" key={server.id}>
                  <span className="prov-pxe-light" data-status={server.reachability} aria-label={server.reachability} />
                  <span className="provision-pxe-info">
                    <b>{server.name}</b>
                    <small>{server.username}@{server.host} · {server.detail || server.reachability}</small>
                  </span>
                  {server.id === activePxeId && data?.hop?.connected ? <em>Active</em> : null}
                  <button type="button" className="btn" disabled={busy || server.reachability === "checking"} onClick={() => void checkPxeServer(server)}>
                    Check
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void connectPxeProfile(server)}>
                    Connect
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void removePxeProfile(server)}>
                    Remove
                  </button>
                </div>
              ))
            ) : (
              <p className="widget-meta">No PXE servers saved yet. The configured Argus controller is still synced.</p>
            )}
          </div>
          <div className="provision-pxe-add">
            <p className="field-label">Add PXE server</p>
            <label className="field-label">
              Name
              <input className="field" value={hopName} onChange={(e) => setHopName(e.target.value)} placeholder="e.g. Argus rack 1 PXE" />
            </label>
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
            <button type="button" className="btn btn-primary" disabled={busy} onClick={addPxeProfile}>
              Save server
            </button>
          </div>
        </ThemeDialog>
      )}
      {removeRack && (
        <ThemeDialog
          title={`Remove ${removeRack.name}`}
          confirmLabel="Remove rack"
          danger
          busy={busy}
          onClose={() => setRemoveRack(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              const out = await api.provisionDeleteRack(removeRack.id);
              setData(out);
              const gone = new Set((out.nodes || []).map((n) => n.id));
              if (focus && !gone.has(focus)) {
                setFocus(null);
                setKvm(null);
              }
              setRemoveRack(null);
              setAddNote("");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not remove rack");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="widget-meta" style={{ margin: 0 }}>
            {removeRack.type === "placeholder"
              ? `Deletes the seeded floor (${removeRack.serial || removeRack.name}, ${removeRack.counts.nodes} racks) from L12. Argus is not changed.`
              : removeRack.name.toLowerCase() === "unassigned"
                ? "Deletes these unassigned nodes from L12. A new node without a rack name becomes its own rack."
                : "Deletes this rack from L12. The next Argus sync adds it back if the PXE still has it."}
          </p>
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

function sshOnly(kind: string) {
  return kind === "leaf" || kind === "spine" || kind === "power";
}

const GROUPS: { key: GroupKey; label: string; kinds: string[] }[] = [
  { key: "compute", label: "Nodes", kinds: ["compute"] },
  { key: "leaf", label: "Switches", kinds: ["leaf", "spine"] },
  { key: "power", label: "Power shelves", kinds: ["power"] },
];

function RackTree({
  rack,
  kids,
  pxeServers,
  opened,
  openGroups,
  focus,
  mayEdit,
  onToggleRack,
  onToggleGroup,
  onOpen,
  onRemove,
}: {
  rack: ProvisionRack;
  kids: InventoryNode[];
  pxeServers: PxeServer[];
  opened: boolean;
  openGroups: Record<string, boolean>;
  focus: string | null;
  mayEdit: boolean;
  onToggleRack: () => void;
  onToggleGroup: (id: string) => void;
  onOpen: (id: string) => void;
  onRemove: () => void;
}) {
  const pxeHosts = [...new Set(kids.map((node) => node.pxe_server).filter((host): host is string => Boolean(host)))];
  const sources = [...new Set(kids.map((node) => node.source || "demo"))];
  const sourceLabel =
    rack.type === "placeholder"
      ? "Seeded floor"
      : [
          ...(sources.includes("argus") ? ["Argus"] : []),
          ...(sources.includes("manual") || sources.includes("provision") ? ["Manual"] : []),
        ].join(" + ") || "Demo";
  const pxeLabels = pxeHosts.map((host) => {
    const server = pxeServers.find((entry) => entry.host === host);
    return server ? `${server.name} (${host})` : host;
  });
  return (
    <>
      <tr className="inv-parent" onClick={onToggleRack} data-mona-rack={rack.name}>
        <td>
          <span className="inv-tri" data-open={opened ? "true" : undefined} />
          <b>{rack.name}</b>
          <em>{rack.serial}</em>
          {mayEdit ? (
            <button
              type="button"
              className="prov-rack-remove"
              data-mona="remove-rack"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              Remove
            </button>
          ) : null}
        </td>
        <td>
          <span>{rack.status}</span>
          <small className="provision-rack-meta">
            {sourceLabel} · PXE {pxeLabels.length ? pxeLabels.join(", ") : "unassigned"}
          </small>
        </td>
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
              data-mona-node={n.id}
              data-mona-rack={n.name}
              data-bmc-ip={n.bmc_ip || undefined}
              data-os-ip={n.os_ip || undefined}
              data-serial={n.serial || undefined}
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
