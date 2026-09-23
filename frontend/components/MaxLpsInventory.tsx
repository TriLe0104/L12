"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { MaxLpsInvGpu, MaxLpsInvNode, MaxLpsInvRack, MaxLpsInventory, MaxLpsInvShelf } from "@/lib/cluster";

type Tab = "rack" | "nodes" | "shelves" | "gpus";

export function MaxLpsInventoryPanel({
  inventory,
  selectedId,
  onChange,
  onClose,
}: {
  inventory: MaxLpsInventory;
  selectedId: string | null;
  onChange: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("rack");
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [serial, setSerial] = useState("");
  const [hall, setHall] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const selected = inventory.racks.find((r) => r.id === selectedId) ?? inventory.racks[0] ?? null;

  useEffect(() => {
    setTab("rack");
  }, [selectedId]);

  async function syncNow() {
    setBusy(true);
    setErr(null);
    try {
      const out = await api.syncMaxlpsInventory();
      setSyncNote(`Synced ${out.created ?? 0} new · ${out.updated ?? 0} updated from cluster controller`);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function addRack() {
    setBusy(true);
    setErr(null);
    try {
      await api.createMaxlpsRack({
        label: label.trim(),
        serial: serial.trim() || undefined,
        hall: hall.trim() || undefined,
      });
      setLabel("");
      setSerial("");
      setHall("");
      setAdding(false);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add rack");
    } finally {
      setBusy(false);
    }
  }

  async function removeRack(id: string, name: string) {
    if (!window.confirm(`Remove ${name} and its nodes, BMCs, GPUs, shelves, and watt samples?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteMaxlpsRack(id);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove rack");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="maxlps-inv">
      <header>
        <h2>Hardware inventory</h2>
        <button type="button" className="maxlps-clear" onClick={onClose}>
          Close
        </button>
      </header>
      <p>
        {inventory.source === "inventory"
          ? `${inventory.count} rack${inventory.count === 1 ? "" : "s"} in Dynamic Power Mode · ${inventory.layout.nodes_per_rack} nodes · ${inventory.layout.gpus_per_rack} GPU · ${inventory.layout.shelves_per_rack} PS`
          : "Board still uses floor-plan simulation. Sync or add a rack to switch Dynamic Power Mode to this inventory."}
      </p>
      {syncNote ? <p>{syncNote}</p> : null}
      <div className="maxlps-inv-actions">
        <button type="button" className="maxlps-clear" onClick={() => void syncNow()} disabled={busy}>
          Sync from controller
        </button>
        <button type="button" className="maxlps-clear" onClick={() => setAdding((v) => !v)} disabled={busy}>
          {adding ? "Cancel" : "Add rack"}
        </button>
        {selected ? (
          <button type="button" className="maxlps-clear" onClick={() => void removeRack(selected.id, selected.label)} disabled={busy}>
            Remove {selected.label}
          </button>
        ) : null}
      </div>
      {adding ? (
        <form
          className="maxlps-inv-add"
          onSubmit={(e) => {
            e.preventDefault();
            void addRack();
          }}
        >
          <label>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="DH01-R01C01" required />
          </label>
          <label>
            Rack SN
            <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="S1234567890" />
          </label>
          <label>
            Hall
            <input value={hall} onChange={(e) => setHall(e.target.value)} placeholder="DH-01" />
          </label>
          <button type="submit" disabled={busy || !label.trim()}>
            Create NVL72
          </button>
        </form>
      ) : null}
      {err ? <p className="cluster-error">{err}</p> : null}
      {selected ? (
        <>
          <div className="maxlps-inv-tabs">
            {(["rack", "nodes", "shelves", "gpus"] as Tab[]).map((t) => (
              <button key={t} type="button" data-on={tab === t ? "true" : undefined} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          {tab === "rack" ? <RackFields rack={selected} onChange={onChange} /> : null}
          {tab === "nodes" ? <NodeTable nodes={selected.nodes} onChange={onChange} /> : null}
          {tab === "shelves" ? <ShelfTable shelves={selected.shelves} onChange={onChange} /> : null}
          {tab === "gpus" ? <GpuTable gpus={selected.gpus} onChange={onChange} /> : null}
        </>
      ) : (
        <p className="maxlps-hint">Add a rack to store serials, BMC, and power-shelf IPs.</p>
      )}
    </aside>
  );
}

function RackFields({ rack, onChange }: { rack: MaxLpsInvRack; onChange: () => void }) {
  const [label, setLabel] = useState(rack.label);
  const [serial, setSerial] = useState(rack.serial ?? "");
  const [hall, setHall] = useState(rack.hall ?? "");
  const [notes, setNotes] = useState(rack.notes ?? "");
  useEffect(() => {
    setLabel(rack.label);
    setSerial(rack.serial ?? "");
    setHall(rack.hall ?? "");
    setNotes(rack.notes ?? "");
  }, [rack]);
  async function save() {
    await api.patchMaxlpsRack(rack.id, { label, serial: serial || null, hall: hall || null, notes: notes || null });
    onChange();
  }
  return (
    <form
      className="maxlps-inv-add"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        Label
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>
        Rack SN
        <input value={serial} onChange={(e) => setSerial(e.target.value)} />
      </label>
      <label>
        Hall
        <input value={hall} onChange={(e) => setHall(e.target.value)} />
      </label>
      <label>
        Notes
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <button type="submit">Save rack</button>
    </form>
  );
}

function NodeTable({ nodes, onChange }: { nodes: MaxLpsInvNode[]; onChange: () => void }) {
  return (
    <div className="maxlps-inv-table-wrap">
      <table className="maxlps-inv-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Node SN</th>
            <th>BMC MAC</th>
            <th>BMC IP</th>
            <th>Password</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <NodeRow key={n.id} node={n} onChange={onChange} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeRow({ node, onChange }: { node: MaxLpsInvNode; onChange: () => void }) {
  const [serial, setSerial] = useState(node.serial ?? "");
  const [mac, setMac] = useState(node.bmc_mac ?? "");
  const [ip, setIp] = useState(node.bmc_ip ?? "");
  const [pw, setPw] = useState(node.bmc_password ?? "");
  useEffect(() => {
    setSerial(node.serial ?? "");
    setMac(node.bmc_mac ?? "");
    setIp(node.bmc_ip ?? "");
    setPw(node.bmc_password ?? "");
  }, [node]);
  async function save() {
    await api.patchMaxlpsNode(node.id, { serial, bmc_mac: mac, bmc_ip: ip, bmc_password: pw });
    onChange();
  }
  return (
    <tr>
      <td>n{String(node.index).padStart(2, "0")}</td>
      <td>
        <input value={serial} onChange={(e) => setSerial(e.target.value)} onBlur={() => void save()} />
      </td>
      <td>
        <input value={mac} onChange={(e) => setMac(e.target.value)} onBlur={() => void save()} />
      </td>
      <td>
        <input value={ip} onChange={(e) => setIp(e.target.value)} onBlur={() => void save()} />
      </td>
      <td>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onBlur={() => void save()} autoComplete="off" />
      </td>
    </tr>
  );
}

function ShelfTable({ shelves, onChange }: { shelves: MaxLpsInvShelf[]; onChange: () => void }) {
  return (
    <div className="maxlps-inv-table-wrap">
      <table className="maxlps-inv-table">
        <thead>
          <tr>
            <th>#</th>
            <th>SN</th>
            <th>IP</th>
            <th>MAC</th>
          </tr>
        </thead>
        <tbody>
          {shelves.map((s) => (
            <ShelfRowEdit key={s.id} shelf={s} onChange={onChange} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShelfRowEdit({ shelf, onChange }: { shelf: MaxLpsInvShelf; onChange: () => void }) {
  const [serial, setSerial] = useState(shelf.serial ?? "");
  const [ip, setIp] = useState(shelf.ip ?? "");
  const [mac, setMac] = useState(shelf.mac ?? "");
  useEffect(() => {
    setSerial(shelf.serial ?? "");
    setIp(shelf.ip ?? "");
    setMac(shelf.mac ?? "");
  }, [shelf]);
  async function save() {
    await api.patchMaxlpsShelf(shelf.id, { serial, ip, mac });
    onChange();
  }
  return (
    <tr>
      <td>PS{shelf.index}</td>
      <td>
        <input value={serial} onChange={(e) => setSerial(e.target.value)} onBlur={() => void save()} />
      </td>
      <td>
        <input value={ip} onChange={(e) => setIp(e.target.value)} onBlur={() => void save()} />
      </td>
      <td>
        <input value={mac} onChange={(e) => setMac(e.target.value)} onBlur={() => void save()} />
      </td>
    </tr>
  );
}

function GpuTable({ gpus, onChange }: { gpus: MaxLpsInvGpu[]; onChange: () => void }) {
  return (
    <div className="maxlps-inv-table-wrap">
      <table className="maxlps-inv-table">
        <thead>
          <tr>
            <th>Slot</th>
            <th>GPU SN</th>
            <th>UUID</th>
            <th>PCI</th>
          </tr>
        </thead>
        <tbody>
          {gpus.map((g) => (
            <GpuRowEdit key={g.id} gpu={g} onChange={onChange} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GpuRowEdit({ gpu, onChange }: { gpu: MaxLpsInvGpu; onChange: () => void }) {
  const [serial, setSerial] = useState(gpu.serial ?? "");
  const [uuid, setUuid] = useState(gpu.uuid ?? "");
  const [pci, setPci] = useState(gpu.pci_addr ?? "");
  useEffect(() => {
    setSerial(gpu.serial ?? "");
    setUuid(gpu.uuid ?? "");
    setPci(gpu.pci_addr ?? "");
  }, [gpu]);
  async function save() {
    await api.patchMaxlpsInvGpu(gpu.id, { serial, uuid, pci_addr: pci });
    onChange();
  }
  return (
    <tr>
      <td>
        n{String(gpu.node_index).padStart(2, "0")}·g{gpu.gpu_index}
      </td>
      <td>
        <input value={serial} onChange={(e) => setSerial(e.target.value)} onBlur={() => void save()} />
      </td>
      <td>
        <input value={uuid} onChange={(e) => setUuid(e.target.value)} onBlur={() => void save()} />
      </td>
      <td>
        <input value={pci} onChange={(e) => setPci(e.target.value)} onBlur={() => void save()} />
      </td>
    </tr>
  );
}
