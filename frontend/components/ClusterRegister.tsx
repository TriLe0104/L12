"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { MaxLpsInvRack } from "@/lib/cluster";

export function ClusterRegister({
  clusterName,
  onDone,
}: {
  clusterName?: string;
  onDone?: () => void;
}) {
  const [name, setName] = useState(clusterName ?? "");
  const [racks, setRacks] = useState<MaxLpsInvRack[]>([]);
  const [mode, setMode] = useState<"rack" | "node" | "edit">("rack");
  const [label, setLabel] = useState("");
  const [serial, setSerial] = useState("");
  const [hall, setHall] = useState("");
  const [rackId, setRackId] = useState("");
  const [editId, setEditId] = useState("");
  const [editNodeId, setEditNodeId] = useState("");
  const [bmcIp, setBmcIp] = useState("");
  const [bmcUser, setBmcUser] = useState("root");
  const [bmcPassword, setBmcPassword] = useState("");
  const [osIp, setOsIp] = useState("");
  const [osUser, setOsUser] = useState("root");
  const [osPassword, setOsPassword] = useState("");
  const [hostname, setHostname] = useState("");
  const [nodeSerial, setNodeSerial] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  function loadRacks() {
    api
      .maxlpsInventory()
      .then((d) => {
        const next = d.racks ?? [];
        setRacks(next);
        setRackId((cur) => (next.some((r) => r.id === cur) ? cur : next[0]?.id || ""));
        if (!hydrated) {
          setOpen(next.length === 0);
          setHydrated(true);
        }
      })
      .catch(() => {
        if (!hydrated) setHydrated(true);
      });
  }

  useEffect(() => {
    loadRacks();
  }, []);

  useEffect(() => {
    function onEdit(e: Event) {
      const id = String((e as CustomEvent<{ id?: string }>).detail?.id || "");
      const rack = racks.find((r) => r.id === id);
      if (rack) startEdit(rack);
    }
    function onRemove(e: Event) {
      const id = String((e as CustomEvent<{ id?: string }>).detail?.id || "");
      const rack = racks.find((r) => r.id === id);
      if (rack) {
        void removeRack(rack);
        return;
      }
      if (!id || !window.confirm("Remove this seeded rack from the floor?")) return;
      void api
        .deleteRack(id)
        .then(() => onDone?.())
        .catch((err: unknown) => setErr(err instanceof Error ? err.message : "Could not remove rack"));
    }
    window.addEventListener("l12-edit-rack", onEdit);
    window.addEventListener("l12-remove-rack", onRemove);
    return () => {
      window.removeEventListener("l12-edit-rack", onEdit);
      window.removeEventListener("l12-remove-rack", onRemove);
    };
  }, [racks, onDone]);

  useEffect(() => {
    if (clusterName) setName(clusterName);
  }, [clusterName]);

  async function saveName() {
    const next = name.trim();
    if (!next) return;
    await api.patchClusterName(next);
  }

  async function addRack() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      if (name.trim() && name.trim() !== clusterName) await saveName();
      const node =
        bmcIp.trim() || bmcPassword || osIp.trim() || osPassword
          ? {
              bmc_ip: bmcIp.trim() || undefined,
              bmc_user: bmcUser.trim() || "root",
              bmc_password: bmcPassword || undefined,
              os_ip: osIp.trim() || undefined,
              os_username: osUser.trim() || "root",
              os_password: osPassword || undefined,
              hostname: hostname.trim() || undefined,
              serial: nodeSerial.trim() || undefined,
            }
          : undefined;
      await api.createMaxlpsRack({
        label: label.trim(),
        serial: serial.trim() || undefined,
        hall: hall.trim() || undefined,
        node,
      });
      setLabel("");
      setSerial("");
      setHall("");
      setBmcIp("");
      setBmcPassword("");
      setOsIp("");
      setOsPassword("");
      setHostname("");
      setNodeSerial("");
      setNote("Rack added. Dashboard uses this inventory for telemetry.");
      loadRacks();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add rack");
    } finally {
      setBusy(false);
    }
  }

  async function addNode() {
    if (!rackId) {
      setErr("Add a rack first");
      return;
    }
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api.assignMaxlpsNode(rackId, {
        bmc_ip: bmcIp.trim() || undefined,
        bmc_user: bmcUser.trim() || "root",
        bmc_password: bmcPassword || undefined,
        os_ip: osIp.trim() || undefined,
        os_username: osUser.trim() || "root",
        os_password: osPassword || undefined,
        hostname: hostname.trim() || undefined,
        serial: nodeSerial.trim() || undefined,
      });
      setBmcIp("");
      setBmcPassword("");
      setOsIp("");
      setOsPassword("");
      setHostname("");
      setNodeSerial("");
      setNote("Node added to the next free slot.");
      loadRacks();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add node");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(rack: MaxLpsInvRack) {
    const node = (rack.nodes ?? []).find((n) => (n.bmc_ip || "").trim()) || rack.nodes?.[0];
    setMode("edit");
    setOpen(true);
    setEditId(rack.id);
    setRackId(rack.id);
    setLabel(rack.label);
    setSerial(rack.serial ?? "");
    setHall(rack.hall ?? "");
    setEditNodeId(node?.id || "");
    setBmcIp(node?.bmc_ip ?? "");
    setBmcUser(node?.bmc_user || "root");
    setBmcPassword("");
    setOsIp(node?.os_ip ?? "");
    setOsUser(node?.os_username || "root");
    setOsPassword("");
    setHostname(node?.hostname ?? "");
    setNodeSerial(node?.serial ?? "");
    setErr(null);
    setNote(null);
  }

  async function saveEdit() {
    if (!editId) {
      setErr("Select a rack to edit");
      return;
    }
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      if (name.trim() && name.trim() !== clusterName) await saveName();
      await api.patchMaxlpsRack(editId, {
        label: label.trim(),
        serial: serial.trim() || null,
        hall: hall.trim() || null,
      });
      if (editNodeId) {
        const payload: {
          bmc_ip?: string | null;
          bmc_user?: string;
          bmc_password?: string;
          os_ip?: string | null;
          os_username?: string;
          os_password?: string;
          hostname?: string | null;
          serial?: string | null;
        } = {
          bmc_ip: bmcIp.trim() || null,
          bmc_user: bmcUser.trim() || "root",
          os_ip: osIp.trim() || null,
          os_username: osUser.trim() || "root",
          hostname: hostname.trim() || null,
          serial: nodeSerial.trim() || null,
        };
        if (bmcPassword) payload.bmc_password = bmcPassword;
        if (osPassword) payload.os_password = osPassword;
        await api.patchMaxlpsNode(editNodeId, payload);
      }
      setNote("Rack updated.");
      loadRacks();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not update rack");
    } finally {
      setBusy(false);
    }
  }

  async function removeRack(rack: MaxLpsInvRack) {
    if (!window.confirm(`Remove ${rack.label} and its nodes, BMCs, GPUs, shelves, and watt samples?`)) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api.deleteMaxlpsRack(rack.id);
      if (editId === rack.id) {
        setEditId("");
        setEditNodeId("");
        setMode("rack");
        setLabel("");
        setSerial("");
        setHall("");
      }
      setNote(`Removed ${rack.label}.`);
      loadRacks();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove rack");
    } finally {
      setBusy(false);
    }
  }

  async function syncArgus() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const out = await api.syncMaxlpsInventory();
      const pxes = out.ok_pxes?.length ? ` · ${out.ok_pxes.length} PXE` : "";
      setNote(
        `Argus: ${out.created ?? 0} new · ${out.updated ?? 0} updated` +
          ((out.removed ?? 0) > 0 ? ` · ${out.removed} removed` : "") +
          pxes,
      );
      if (out.errors?.length) setErr(out.errors.join("; "));
      loadRacks();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Argus sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cluster-register" data-mona="register">
      <header>
        <div>
          <h2>Register hardware</h2>
          <small>Manual cluster, rack, or node — Argus sync is optional.</small>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Add"}
        </button>
      </header>
      {open ? (
      <>
      <div className="cluster-register-modes">
        <button type="button" data-on={mode === "rack"} onClick={() => setMode("rack")}>
          Add rack
        </button>
        <button type="button" data-on={mode === "node"} onClick={() => setMode("node")} disabled={!racks.length}>
          Add node
        </button>
        <button type="button" data-on={mode === "edit"} onClick={() => (editId ? setMode("edit") : racks[0] && startEdit(racks[0]))} disabled={!racks.length}>
          Edit rack
        </button>
        <button type="button" onClick={() => void syncArgus()} disabled={busy}>
          Sync from Argus
        </button>
      </div>
      <form
        className="cluster-register-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "node") void addNode();
          else if (mode === "edit") void saveEdit();
          else void addRack();
        }}
      >
        <label>
          Cluster
          <input data-mona="cluster-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Cluster name" />
        </label>
        {mode === "node" ? (
          <label>
            Rack
            <select value={rackId} onChange={(e) => setRackId(e.target.value)}>
              {racks.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                  {r.origin === "argus" ? " · Argus" : " · manual"}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            {mode === "edit" ? (
              <label>
                Rack
                <select
                  value={editId}
                  onChange={(e) => {
                    const next = racks.find((r) => r.id === e.target.value);
                    if (next) startEdit(next);
                  }}
                >
                  {racks.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                      {r.origin === "argus" ? " · Argus" : " · manual"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              Rack label
              <input data-mona="rack-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="GB300-Temp" required />
            </label>
            <label>
              Hall
              <input data-mona="hall" value={hall} onChange={(e) => setHall(e.target.value)} placeholder="Live" />
            </label>
            <label>
              Rack serial
              <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="optional" />
            </label>
          </>
        )}
        <label>
          BMC IP
          <input data-mona="bmc-ip" value={bmcIp} onChange={(e) => setBmcIp(e.target.value)} placeholder="10.43.143.98" />
        </label>
        <label>
          BMC user
          <input data-mona="bmc-user" value={bmcUser} onChange={(e) => setBmcUser(e.target.value)} />
        </label>
        <label>
          BMC password
          <input data-mona="bmc-password" type="password" value={bmcPassword} onChange={(e) => setBmcPassword(e.target.value)} autoComplete="off" />
        </label>
        <label>
          OS IP
          <input data-mona="os-ip" value={osIp} onChange={(e) => setOsIp(e.target.value)} placeholder="node SSH address" />
        </label>
        <label>
          OS user
          <input data-mona="os-user" value={osUser} onChange={(e) => setOsUser(e.target.value)} />
        </label>
        <label>
          OS password
          <input data-mona="os-password" type="password" value={osPassword} onChange={(e) => setOsPassword(e.target.value)} autoComplete="off" />
        </label>
        <label>
          Node hostname
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="slot 0" />
        </label>
        <label>
          Node serial
          <input value={nodeSerial} onChange={(e) => setNodeSerial(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || (mode === "node" ? !rackId : !label.trim())}>
          {mode === "node" ? "Add node" : mode === "edit" ? "Save rack" : "Add rack"}
        </button>
      </form>
      {note ? <p className="cluster-register-note">{note}</p> : null}
      {err ? <p className="cluster-error">{err}</p> : null}
      </>
      ) : null}
    </section>
  );
}
