"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type { ClusterWorkload } from "@/lib/cluster";
import { WORKLOAD_KIND_LABEL } from "@/lib/cluster";

import "../cluster/cluster.css";
import "./testing.css";

type Category = "mlperf" | "network" | "nccl";

type TestCard = {
  name: string;
  label: string;
  kind: string;
  gpu_request: number;
  gpu_mem_gb_request: number;
  pods_requested: number;
  detail: string;
};

const CATALOG: { id: Category; label: string; blurb: string; tests: TestCard[] }[] = [
  {
    id: "mlperf",
    label: "MLPerf",
    blurb: "Training and inference benchmarks",
    tests: [
      { name: "mlperf-gpt3-175b", label: "GPT-3 175B", kind: "mlperf", gpu_request: 64, gpu_mem_gb_request: 5120, pods_requested: 8, detail: "LLM training · 64 GPU" },
      { name: "mlperf-llama2-70b", label: "Llama 2 70B", kind: "mlperf", gpu_request: 16, gpu_mem_gb_request: 1280, pods_requested: 2, detail: "Inference · 16 GPU" },
      { name: "mlperf-llama3-70b", label: "Llama 3 70B", kind: "mlperf", gpu_request: 16, gpu_mem_gb_request: 1280, pods_requested: 2, detail: "Inference · 16 GPU" },
      { name: "mlperf-mixtral-8x7b", label: "Mixtral 8×7B", kind: "mlperf", gpu_request: 8, gpu_mem_gb_request: 640, pods_requested: 1, detail: "MoE inference · 8 GPU" },
      { name: "mlperf-bert-large", label: "BERT Large", kind: "mlperf", gpu_request: 8, gpu_mem_gb_request: 320, pods_requested: 1, detail: "NLP · 8 GPU" },
      { name: "mlperf-resnet50", label: "ResNet-50", kind: "mlperf", gpu_request: 8, gpu_mem_gb_request: 320, pods_requested: 1, detail: "Vision · 8 GPU" },
      { name: "mlperf-retinanet", label: "RetinaNet", kind: "mlperf", gpu_request: 8, gpu_mem_gb_request: 320, pods_requested: 1, detail: "Detection · 8 GPU" },
      { name: "mlperf-dlrm-dcnv2", label: "DLRM DCN-v2", kind: "mlperf", gpu_request: 8, gpu_mem_gb_request: 640, pods_requested: 1, detail: "Recommendation · 8 GPU" },
      { name: "mlperf-rnnt", label: "RNN-T", kind: "mlperf", gpu_request: 8, gpu_mem_gb_request: 320, pods_requested: 1, detail: "Speech · 8 GPU" },
    ],
  },
  {
    id: "network",
    label: "Network",
    blurb: "InfiniBand perftest",
    tests: [
      { name: "ib_write_bw", label: "IB_WRITE_BW", kind: "network", gpu_request: 0, gpu_mem_gb_request: 0, pods_requested: 2, detail: "RDMA write bandwidth (perftest)" },
      { name: "ib_read_bw", label: "IB_READ_BW", kind: "network", gpu_request: 0, gpu_mem_gb_request: 0, pods_requested: 2, detail: "RDMA read bandwidth" },
      { name: "ib_send_bw", label: "IB_SEND_BW", kind: "network", gpu_request: 0, gpu_mem_gb_request: 0, pods_requested: 2, detail: "Send/recv bandwidth" },
    ],
  },
  {
    id: "nccl",
    label: "NCCL Stress Test",
    blurb: "Collectives and GPU health",
    tests: [
      { name: "dcgm-diag", label: "DCGM", kind: "nccl", gpu_request: 8, gpu_mem_gb_request: 0, pods_requested: 1, detail: "NVIDIA DCGM diagnostics (r1/r2/r3)" },
      { name: "nccl-all_reduce", label: "NCCL all_reduce", kind: "nccl", gpu_request: 64, gpu_mem_gb_request: 0, pods_requested: 8, detail: "NCCL stress · all_reduce" },
      { name: "nccl-all_gather", label: "NCCL all_gather", kind: "nccl", gpu_request: 64, gpu_mem_gb_request: 0, pods_requested: 8, detail: "NCCL stress · all_gather" },
    ],
  },
];

function ago(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const s = Math.max(0, Date.now() - t);
  const d = Math.floor(s / 86400000);
  const h = Math.floor((s % 86400000) / 3600000);
  const m = Math.floor((s % 3600000) / 60000);
  if (d > 0) return `${d}d-${h}h-${m}m`;
  if (h > 0) return `${h}h-${m}m`;
  return `${m}m`;
}

function memLabel(gb: number) {
  if (!gb) return "—";
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb} GB`;
}

export default function TestingPage() {
  const { user } = useAuth();
  const mayEdit = canEdit(user);
  const [rows, setRows] = useState<ClusterWorkload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<Category>("mlperf");
  const [picked, setPicked] = useState<string>("mlperf-gpt3-175b");

  const load = useCallback(async () => {
    setRows(await api.listWorkloads());
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load workloads"));
  }, [load]);

  const group = CATALOG.find((c) => c.id === category)!;
  const selected = group.tests.find((t) => t.name === picked) ?? group.tests[0];

  const shown = useMemo(() => {
    return rows.filter((w) => w.kind === category || group.tests.some((t) => t.name === w.name));
  }, [rows, category, group.tests]);

  async function launch(test: TestCard) {
    if (!mayEdit) return;
    setBusy(true);
    setError(null);
    try {
      await api.createWorkload({
        name: test.name,
        kind: test.kind,
        project: "firmus",
        node_pool: "gb300",
        gpu_request: test.gpu_request,
        gpu_mem_gb_request: test.gpu_mem_gb_request,
        pods_requested: test.pods_requested,
        detail: test.detail,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start test");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: string) {
    await api.updateWorkload(id, { status });
    await load();
  }

  return (
    <div className="cluster-app testing-page">
      <header className="testing-head">
        <div>
          <h1>Testing</h1>
          <p>Select a suite, then a model or test</p>
        </div>
        <div className="testing-tools">
          <span className="chip" data-tone="on">
            Cluster: firmus
          </span>
        </div>
      </header>

      {error && <p className="cluster-error">{error}</p>}

      <nav className="test-cats" aria-label="Test suite">
        {CATALOG.map((c) => (
          <button
            key={c.id}
            type="button"
            data-active={category === c.id}
            onClick={() => {
              setCategory(c.id);
              setPicked(c.tests[0].name);
            }}
          >
            <b>{c.label}</b>
            <span>{c.blurb}</span>
          </button>
        ))}
      </nav>

      <div className="test-pick">
        {group.tests.map((t) => (
          <button
            key={t.name}
            type="button"
            className="test-card"
            data-active={picked === t.name}
            onClick={() => setPicked(t.name)}
            onDoubleClick={() => launch(t)}
          >
            <b>{t.label}</b>
            <span>{t.detail}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="test-launch">
          <div>
            <strong>{selected.label}</strong>
            <span>
              {WORKLOAD_KIND_LABEL[selected.kind] ?? selected.kind}
              {selected.gpu_request ? ` · ${selected.gpu_request} GPU` : ""}
              {selected.pods_requested ? ` · ${selected.pods_requested} pods` : ""}
            </span>
          </div>
          {mayEdit && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => launch(selected)}>
              Launch
            </button>
          )}
        </div>
      )}

      <div className="testing-table-wrap">
        <table className="testing-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Type</th>
              <th>Status</th>
              <th>Node pool</th>
              <th>Pods</th>
              <th>GPU</th>
              <th>GPU mem</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w.id} data-status={w.status}>
                <td>
                  <b>{w.name}</b>
                </td>
                <td>{WORKLOAD_KIND_LABEL[w.kind] ?? w.kind}</td>
                <td className="status-cell">
                  {w.status === "failed"
                    ? `Failed (${ago(w.finished_at)})`
                    : w.status === "stopped"
                      ? `Stopped (${ago(w.finished_at)})`
                      : w.status === "completed"
                        ? `Completed (${ago(w.finished_at)})`
                        : w.status === "running"
                          ? `Running (${ago(w.started_at)})`
                          : "Pending"}
                </td>
                <td>{w.node_pool ?? "—"}</td>
                <td>
                  {w.pods_running}/{w.pods_requested}
                </td>
                <td>
                  {w.gpu_allocation || w.gpu_request || "—"}
                </td>
                <td>{memLabel(w.gpu_mem_gb_alloc || w.gpu_mem_gb_request)}</td>
                <td className="row-actions">
                  {mayEdit && w.status === "running" && (
                    <button type="button" className="btn" onClick={() => setStatus(w.id, "stopped")}>
                      Stop
                    </button>
                  )}
                  {mayEdit && (w.status === "failed" || w.status === "stopped" || w.status === "pending") && (
                    <button type="button" className="btn" onClick={() => setStatus(w.id, "running")}>
                      Start
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="widget-empty">No runs in this suite yet</p>}
      </div>
    </div>
  );
}
