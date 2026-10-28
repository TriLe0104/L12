"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type { ClusterWorkload, MaxLpsInvRack } from "@/lib/cluster";
import { WORKLOAD_KIND_LABEL } from "@/lib/cluster";

import "../cluster/cluster.css";
import "./testing.css";

type TestCard = {
  id?: string;
  name: string;
  label: string;
  kind: string;
  component?: string;
  gpu_request: number;
  gpu_mem_gb_request: number;
  pods_requested: number;
  detail: string;
  source?: string;
  subtests?: { id: string; label: string }[];
};

type Comp = { id: string; label: string; blurb: string; count?: number };

type Report = {
  serial_number?: string;
  type?: string;
  path?: string;
  name?: string;
  date_created?: string;
  test_runs?: (string | number)[];
};

type ReportPreview = {
  title: string;
  url: string;
  mime: string;
  filename: string;
  kind: string;
  path?: string;
  text?: string;
  sheets?: { name: string; rows: string[][] }[];
  truncated?: boolean;
};

type Pane = "tests" | "sanity" | "reports";

type SanityCheck = { status?: string; failures?: string[]; detail?: string };

type SanityNode = {
  label?: string;
  serial?: string | null;
  hostname?: string | null;
  overall?: string;
  timestamp?: string | null;
  skip_reason?: string | null;
  checks?: Record<string, SanityCheck>;
  log?: string[];
};

type TestJob = {
  id: string;
  name: string;
  kind: string;
  status: string;
  doing: string | null;
  test?: string | null;
  rack?: string | null;
  log?: string[];
  minion?: string | null;
  mission?: string | null;
  error?: string | null;
};

type GoldenChip = { exists: boolean; filename: string; mtime: string | null; bytes?: number };

const SANITY_COLS = ["fw", "sw", "bom", "psu", "voltage", "sel"] as const;

const LOCAL: { id: string; label: string; blurb: string; tests: TestCard[] }[] = [
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

function reportName(row: Report): string {
  if (row.name) return row.name;
  const path = row.path || "";
  return path.split(/[/\\]/).pop() || "report";
}

function reportWhen(iso?: string): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString();
}

function reportKind(row: Report): string {
  return (row.type || "").toLowerCase();
}

function usableNodeId(nodes: { id: string; serial?: string | null; hostname?: string | null; bmc_ip?: string | null }[]): string {
  const hit = nodes.find((n) => {
    const host = (n.hostname || "").trim();
    return Boolean((n.bmc_ip || "").trim() || hasSerial(n.serial) || (host && host.toLowerCase() !== "hostname"));
  });
  return hit?.id || "";
}

function hasSerial(serial?: string | null): boolean {
  const text = (serial || "").trim();
  if (!text || text === "—" || text === "-") return false;
  const up = text.toUpperCase();
  return !(up.startsWith("MAC-") || up.startsWith("IP-") || up.startsWith("UNK-"));
}

function checkTone(status?: string): string {
  const s = (status || "").toUpperCase();
  if (s === "PASS") return "pass";
  if (s === "FAIL" || s === "STOPPED") return "fail";
  if (s === "RUNNING") return "run";
  return "skip";
}

export default function TestingPage() {
  const { user } = useAuth();
  const mayEdit = canEdit(user);
  const [pane, setPane] = useState<Pane>("tests");
  const [rows, setRows] = useState<ClusterWorkload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comps, setComps] = useState<Comp[]>(LOCAL.map((c) => ({ id: c.id, label: c.label, blurb: c.blurb })));
  const [tests, setTests] = useState<TestCard[]>(LOCAL.flatMap((c) => c.tests));
  const [source, setSource] = useState("local");
  const [category, setCategory] = useState(LOCAL[0].id);
  const [picked, setPicked] = useState(LOCAL[0].tests[0].name);
  const [reports, setReports] = useState<Report[]>([]);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [reportsReady, setReportsReady] = useState(false);
  const [reportQuery, setReportQuery] = useState("");
  const [reportType, setReportType] = useState("all");
  const [sheet, setSheet] = useState(0);
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [racks, setRacks] = useState<MaxLpsInvRack[]>([]);
  const [rackSerial, setRackSerial] = useState("");
  const [sanity, setSanity] = useState<{
    overall?: string | null;
    status?: string;
    nodes?: Record<string, SanityNode>;
    checks?: { id: string; label: string; blurb: string }[];
    golden?: Record<string, GoldenChip> & {
      capture?: { running?: boolean; error?: string | null; finished_at?: string | null; node?: string | null };
    };
    job?: { running?: boolean };
    rack_serial?: string | null;
    rack_label?: string | null;
    started_at?: string | null;
    finished_at?: string | null;
  } | null>(null);
  const [sanityBusy, setSanityBusy] = useState(false);
  const [captureNode, setCaptureNode] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [jobs, setJobs] = useState<TestJob[]>([]);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [liveNode, setLiveNode] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await api.listWorkloads());
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load workloads"));
    api
      .testCatalog()
      .then((cat) => {
        if (cat.tests?.length) {
          setSource(cat.source || "argus");
          setComps(cat.components.filter((c) => (c.count ?? 0) > 0 || cat.tests.some((t) => t.component === c.id)));
          setTests(
            cat.tests.map((t) => ({
              id: t.id,
              name: t.name,
              label: t.label,
              kind: t.kind,
              component: t.component,
              gpu_request: t.gpu_request,
              gpu_mem_gb_request: t.gpu_mem_gb_request,
              pods_requested: t.pods_requested,
              detail: t.detail,
              source: t.source,
              subtests: t.subtests,
            })),
          );
          const first = cat.components.find((c) => cat.tests.some((t) => t.component === c.id));
          if (first) {
            setCategory(first.id);
            const hit = cat.tests.find((t) => t.component === first.id);
            if (hit) setPicked(hit.name);
          }
        }
      })
      .catch(() => {
        /* keep local catalog */
      });
    api
      .testReports()
      .then((out) => {
        setReports(out.reports || []);
        setReportsError(out.error || null);
      })
      .catch((err) => {
        setReports([]);
        setReportsError(err instanceof Error ? err.message : "Could not load reports");
      })
      .finally(() => setReportsReady(true));
    api
      .maxlpsInventory()
      .then((inv) => {
        const list = inv.racks || [];
        setRacks(list);
        setRackSerial((cur) => {
          if (cur && list.some((r) => (r.serial || r.id) === cur)) return cur;
          const first = list.find((r) => r.serial) || list[0];
          if (!first) return cur;
          setCaptureNode(usableNodeId(first.nodes || []));
          return first.serial || first.id;
        });
      })
      .catch(() => {
        /* inventory optional */
      });
    api
      .sanityStatus()
      .then((out) => setSanity(out))
      .catch(() => setSanity(null));
  }, [load]);

  useEffect(() => {
    const onRefresh = () => {
      load().catch(() => {
        /* keep last runs */
      });
      api.sanityStatus(rackSerial || undefined).then(setSanity).catch(() => {
        /* keep last */
      });
    };
    window.addEventListener("l12-refresh", onRefresh);
    return () => window.removeEventListener("l12-refresh", onRefresh);
  }, [load, rackSerial]);

  const pendingRack = useRef<string[] | null>(null);
  const applyTestingRack = useCallback(
    (needles: string[]) => {
      const want = needles.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0);
      if (!want.length) return;
      if (racks.length === 0) {
        pendingRack.current = want;
        return;
      }
      const hit = racks.find((rack) => {
        const bits = [rack.serial, rack.id, rack.label, ...(rack.nodes || []).flatMap((n) => [n.hostname, n.serial, n.bmc_ip])]
          .map((bit) => (bit || "").trim().toLowerCase())
          .filter(Boolean);
        const label = (rack.label || "").trim().toLowerCase();
        return want.some((needle) =>
          bits.some(
            (bit) => bit === needle || (needle.length >= 4 && bit.includes(needle)) || (label.length >= 2 && bit === label && needle.includes(label)),
          ),
        );
      });
      if (!hit) {
        pendingRack.current = want;
        return;
      }
      pendingRack.current = null;
      setPane("sanity");
      setRackSerial(hit.serial || hit.id);
      const node =
        hit.nodes.find((n) =>
          want.some((needle) => {
            const host = (n.hostname || "").toLowerCase();
            const serial = (n.serial || "").toLowerCase();
            return serial === needle || (needle.length >= 4 && host.includes(needle));
          }),
        ) || hit.nodes[0];
      if (node) setCaptureNode(node.id);
    },
    [racks],
  );

  useEffect(() => {
    const onRack = (ev: Event) => {
      const detail = (ev as CustomEvent<{ rack?: string; serial?: string; id?: string }>).detail || {};
      applyTestingRack([detail.serial || "", detail.id || "", detail.rack || ""]);
    };
    window.addEventListener("l12-testing-rack", onRack);
    return () => window.removeEventListener("l12-testing-rack", onRack);
  }, [applyTestingRack]);

  useEffect(() => {
    if (pendingRack.current?.length) applyTestingRack(pendingRack.current);
  }, [racks, applyTestingRack]);

  useEffect(() => {
    let stop = false;
    const tick = () => {
      api
        .agentJobs()
        .then((out) => {
          if (!stop) setJobs(out.jobs || []);
        })
        .catch(() => undefined);
    };
    tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!sanity?.job?.running && pane !== "sanity") return;
    const tick = () => {
      api.sanityStatus(rackSerial || undefined).then(setSanity).catch(() => {
        /* keep last */
      });
    };
    const id = window.setInterval(tick, 2500);
    return () => window.clearInterval(id);
  }, [sanity?.job?.running, pane, rackSerial]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closePreview();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preview]);

  const groupTests = useMemo(
    () => tests.filter((t) => (t.component || t.kind) === category),
    [tests, category],
  );
  const selected = groupTests.find((t) => t.name === picked) ?? groupTests[0];

  const shown = useMemo(() => {
    return rows.filter((w) => w.kind === category || groupTests.some((t) => t.name === w.name));
  }, [rows, category, groupTests]);

  const reportTypes = useMemo(() => {
    const set = new Set<string>();
    for (const r of reports) {
      const t = reportKind(r);
      if (t) set.add(t);
    }
    return ["all", ...[...set].sort()];
  }, [reports]);

  const filteredReports = useMemo(() => {
    const q = reportQuery.trim().toLowerCase();
    return reports.filter((r) => {
      const kind = reportKind(r);
      if (reportType !== "all" && kind !== reportType) return false;
      if (!q) return true;
      const runs = (r.test_runs || []).join(" ");
      const blob = `${reportName(r)} ${r.serial_number || ""} ${kind} ${runs}`.toLowerCase();
      return blob.includes(q);
    });
  }, [reports, reportQuery, reportType]);

  const pdfCount = reports.filter((r) => reportKind(r) === "pdf").length;
  const xlsCount = reports.filter((r) => reportKind(r) === "xlsx" || reportKind(r) === "xls").length;
  const jsonCount = reports.filter((r) => reportKind(r) === "json").length;

  async function launch(test: TestCard) {
    if (!mayEdit) return;
    setBusy(true);
    setError(null);
    try {
      if (test.source === "l11") {
        const out = await api.runL11Script(test.id || test.name, {
          rack_serial: rackSerial || undefined,
          node: captureNode || undefined,
        });
        if (!out.ok) throw new Error(out.error || "L11 script failed (OS SSH)");
        setPreview({
          title: test.label,
          url: "",
          mime: "text/plain",
          filename: `${test.name}.log`,
          kind: "text",
          text: [out.stdout, out.stderr].filter(Boolean).join("\n") || "exit " + String(out.exit ?? ""),
        });
      } else if (test.source === "argus" || source === "argus") {
        await api.runArgusTest({
          tests: [test.id || test.name],
          rack_serial: rackSerial || undefined,
          node_macs: captureNode ? [captureNode] : undefined,
        });
      } else {
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
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start test");
    } finally {
      setBusy(false);
    }
  }

  async function refreshReports() {
    setReportsReady(false);
    try {
      const out = await api.testReports();
      setReports(out.reports || []);
      setReportsError(out.error || null);
    } catch (err) {
      setReports([]);
      setReportsError(err instanceof Error ? err.message : "Could not load reports");
    } finally {
      setReportsReady(true);
    }
  }

  async function runSanity() {
    if (!mayEdit) return;
    setSanityBusy(true);
    setError(null);
    try {
      const out = await api.runSanity({
        rack_serial: rackSerial || undefined,
        node_macs: captureNode ? [captureNode] : undefined,
      });
      setSanity(out as typeof sanity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start sanity");
    } finally {
      setSanityBusy(false);
    }
  }

  async function captureGold() {
    if (!mayEdit) return;
    setSanityBusy(true);
    setError(null);
    try {
      await api.captureGolden({ rack_serial: rackSerial || undefined, node: captureNode || undefined });
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const out = await api.sanityStatus(rackSerial || undefined);
        setSanity(out);
        const cap = out.golden?.capture;
        if (cap?.running) continue;
        if (cap?.error) throw new Error(cap.error);
        const file = await api.goldenFile("bom");
        const text = typeof file.content === "string" ? file.content : JSON.stringify(file.content, null, 2);
        setPreview({
          title: file.filename || "bom_golden.json",
          url: "",
          mime: "application/json",
          filename: file.filename || "bom_golden.json",
          kind: "json",
          text,
        });
        return;
      }
      throw new Error("Golden capture is still running. Check the BOM chip in a minute.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Golden capture failed");
    } finally {
      setSanityBusy(false);
    }
  }

  async function viewGolden(kind: string) {
    try {
      const file = await api.goldenFile(kind);
      const text = typeof file.content === "string" ? file.content : JSON.stringify(file.content, null, 2);
      setPreview({
        title: file.filename || `${kind} golden`,
        url: "",
        mime: kind === "log" ? "text/plain" : "application/json",
        filename: file.filename || `${kind}.json`,
        kind: kind === "log" ? "text" : "json",
        text,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No golden file");
    }
  }

  async function viewScript(test: TestCard) {
    try {
      const file = await api.l11Script(test.id || test.name);
      setPreview({
        title: file.filename,
        url: "",
        mime: "text/plain",
        filename: file.filename,
        kind: "text",
        text: file.content,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open script");
    }
  }

  async function makeReport(level: "L11" | "L10") {
    if (!mayEdit) return;
    setReportBusy(true);
    setError(null);
    try {
      const out = await api.generateL11Report({
        level,
        rack_serial: rackSerial || undefined,
        node_serial: level === "L10" ? captureNode || undefined : undefined,
      });
      await refreshReports();
      if (out.path) {
        await openReport({ path: out.path, name: out.pdf, type: "pdf", serial_number: out.rack_serial, test_runs: [level] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report generation failed");
    } finally {
      setReportBusy(false);
    }
  }

  async function setStatus(id: string, status: string) {
    await api.updateWorkload(id, { status });
    await load();
  }

  function closePreview() {
    setPreview((cur) => {
      if (cur?.url) URL.revokeObjectURL(cur.url);
      return null;
    });
    setPreviewErr(null);
    setPreviewBusy(false);
  }

  async function downloadReport(row: Report) {
    if (!row.path) return;
    const file = await api.testReportFile(row.path);
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.filename || reportName(row);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function openReport(row: Report) {
    if (!row.path) return;
    const kind = reportKind(row);
    const title = `${reportName(row)}${row.serial_number ? ` · ${row.serial_number}` : ""}`;
    setPreviewErr(null);
    setPreviewBusy(true);
    setSheet(0);
    setPreview((cur) => {
      if (cur?.url) URL.revokeObjectURL(cur.url);
      return {
        title,
        url: "",
        mime: "",
        filename: reportName(row),
        kind: kind || "file",
        path: row.path,
      };
    });
    try {
      if (kind === "xlsx" || kind === "xls" || kind === "json") {
        const prev = await api.testReportPreview(row.path);
        setPreview((cur) => {
          if (cur?.url) URL.revokeObjectURL(cur.url);
          return {
            title,
            url: "",
            mime: prev.mime || "",
            filename: prev.filename || reportName(row),
            kind: prev.kind || kind,
            path: row.path,
            text: prev.text,
            sheets: prev.sheets,
            truncated: prev.truncated,
          };
        });
        return;
      }
      const file = await api.testReportFile(row.path);
      const mime = file.mime || "";
      const isPdf = mime.includes("pdf") || /\.pdf$/i.test(file.filename);
      const isText =
        mime.startsWith("text/") ||
        mime.includes("json") ||
        mime.includes("xml") ||
        mime.includes("csv");
      let text: string | undefined;
      if (!isPdf && isText) {
        text = await file.blob.text();
      }
      const url = URL.createObjectURL(file.blob);
      setPreview((cur) => {
        if (cur?.url) URL.revokeObjectURL(cur.url);
        return {
          title,
          url,
          mime,
          filename: file.filename,
          kind: isPdf ? "pdf" : text ? "text" : kind || "file",
          path: row.path,
          text,
        };
      });
    } catch (err) {
      setPreviewErr(err instanceof Error ? err.message : "Could not open report");
    } finally {
      setPreviewBusy(false);
    }
  }

  return (
    <div className="cluster-app testing-page" data-mona="testing">
      <header className="testing-head">
        <div>
          <h1>Testing</h1>
          <p>
            {pane === "sanity"
              ? "Firmware, software, BOM, PSU, voltage, and SEL — L11 sanity on live BMCs"
              : pane === "reports"
                ? "Argus files plus L10 / L11 PDF, CSV, and JSON generated here"
                : source === "argus"
                  ? "Argus catalog plus L11 NVIDIA benches, grouped by component"
                  : "Select a suite, then a model or test"}
          </p>
        </div>
        <div className="testing-tools">
          {racks.length > 0 ? (
            <select
              data-mona="testing-rack"
              aria-label="Rack"
              value={rackSerial}
              onChange={(e) => {
                const next = e.target.value;
                setRackSerial(next);
                const rack = racks.find((r) => (r.serial || r.id) === next);
                setCaptureNode(usableNodeId(rack?.nodes || []));
              }}
            >
              {racks.map((r) => (
                <option key={r.id} value={r.serial || r.id}>
                  {r.label}
                  {r.serial ? ` · ${r.serial}` : ""}
                </option>
              ))}
            </select>
          ) : null}
          <span className="chip" data-tone="on">
            {source === "argus" ? "Argus" : "Local"}
          </span>
        </div>
      </header>

      <nav className="test-panes" aria-label="Testing section">
        {(
          [
            ["tests", "Tests"],
            ["sanity", "Sanity"],
            ["reports", "Reports"],
          ] as [Pane, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" data-active={pane === id} data-mona={id} onClick={() => setPane(id)}>
            {label}
          </button>
        ))}
      </nav>

      {error && <p className="cluster-error">{error}</p>}

      <section className="test-jobs" data-mona="jobs">
        <header>
          <b>Jobs</b>
          <span>{jobs.filter((job) => job.status === "running").length} running</span>
        </header>
        {jobs.length === 0 ? (
          <p className="widget-empty">No test jobs yet</p>
        ) : (
          <ul>
            {jobs.map((job) => (
              <li key={job.id}>
                <button type="button" onClick={() => setOpenJob((cur) => (cur === job.id ? null : job.id))}>
                  <b>{job.minion || job.name}</b>
                  <span>
                    {job.mission || job.kind}
                    {job.rack ? ` · ${job.rack}` : ""}
                  </span>
                  <em data-tone={checkTone(job.status === "running" ? "RUNNING" : job.status)}>{job.status}</em>
                  {job.doing ? <small>{job.doing}</small> : null}
                </button>
                {openJob === job.id ? (
                  <pre>{(job.log || []).join("\n") || job.error || "No log yet."}</pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {pane === "tests" ? (
        <>
      <nav className="test-cats" aria-label="Test component">
        {comps.map((c) => (
          <button
            key={c.id}
            type="button"
            data-active={category === c.id}
            onClick={() => {
              setCategory(c.id);
              const hit = tests.find((t) => (t.component || t.kind) === c.id);
              if (hit) setPicked(hit.name);
            }}
          >
            <b>{c.label}</b>
            <span>
              {c.blurb}
              {c.count != null ? ` · ${c.count}` : ""}
            </span>
          </button>
        ))}
      </nav>

      <div className="test-pick" data-mona="catalog">
        {groupTests.map((t) => (
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
              {(selected.component || WORKLOAD_KIND_LABEL[selected.kind] || selected.kind).toUpperCase()}
              {selected.gpu_request ? ` · ${selected.gpu_request} GPU` : ""}
              {selected.subtests?.length ? ` · ${selected.subtests.length} subtests` : ""}
            </span>
          </div>
          {selected.source === "l11" ? (
            <button type="button" className="btn" onClick={() => void viewScript(selected)}>
              View script
            </button>
          ) : null}
          {mayEdit && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => launch(selected)}>
              {selected.source === "l11" ? "Run on node" : "Launch"}
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
        {shown.length === 0 && <p className="widget-empty">No local runs in this suite yet</p>}
      </div>
        </>
      ) : null}

      {pane === "sanity" ? (
        <section className="sanity-panel" data-mona="sanity">
          <div className="golden-row" data-mona="golden">
            {(["bom", "fw", "sw", "log"] as const).map((kind) => {
              const chip = sanity?.golden?.[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  className="golden-chip"
                  data-on={chip?.exists ? "true" : "false"}
                  onClick={() => void viewGolden(kind)}
                >
                  <b>{kind.toUpperCase()}</b>
                  <span>{chip?.exists ? ago(chip.mtime) : "missing"}</span>
                </button>
              );
            })}
          </div>
          <div className="sanity-tools">
            <select value={captureNode} onChange={(e) => setCaptureNode(e.target.value)} aria-label="Node">
              {(racks.find((r) => (r.serial || r.id) === rackSerial)?.nodes || [])
                .filter((n) => (n.bmc_ip || "").trim() || hasSerial(n.serial) || ((n.hostname || "").trim() && n.hostname?.toLowerCase() !== "hostname"))
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.hostname || n.serial || `N${n.index}`}
                    {n.serial && n.serial !== n.hostname ? ` · ${n.serial}` : ""}
                  </option>
                ))}
            </select>
            {mayEdit ? (
              <>
                <button type="button" className="btn" disabled={sanityBusy || Boolean(sanity?.golden?.capture?.running)} onClick={() => void captureGold()}>
                  {sanityBusy || sanity?.golden?.capture?.running ? "Capturing…" : "Capture golden"}
                </button>
                <button type="button" className="btn btn-primary" disabled={sanityBusy || !!sanity?.job?.running} onClick={() => void runSanity()}>
                  {sanity?.job?.running ? "Running…" : "Run sanity"}
                </button>
                {sanity?.job?.running ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void api.stopSanity().then(() => api.sanityStatus(rackSerial || undefined).then(setSanity))
                    }
                  >
                    Stop
                  </button>
                ) : null}
              </>
            ) : null}
            <span className="sanity-overall" data-tone={checkTone(sanity?.overall || undefined)}>
              {sanity?.overall || sanity?.status || "no results"}
            </span>
          </div>
          <div className="testing-table-wrap">
            <table className="testing-table sanity-table">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Serial</th>
                  {SANITY_COLS.map((c) => (
                    <th key={c}>{c.toUpperCase()}</th>
                  ))}
                  <th>Overall</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(sanity?.nodes || {})
                  .filter(([, node]) => hasSerial(node.serial))
                  .map(([label, node]) => (
                    <Fragment key={label}>
                      <tr data-status={(node.overall || "").toLowerCase()}>
                        <td>
                          <b>{label}</b>
                          <div className="muted">{node.hostname || "—"}</div>
                        </td>
                        <td>
                          <span className="test-rep-serial">{node.serial || "—"}</span>
                        </td>
                        {SANITY_COLS.map((c) => {
                          const chk = node.checks?.[c];
                          const title = (chk?.failures || []).join("\n") || chk?.detail || "";
                          return (
                            <td key={c} title={title}>
                              <span className="check-pill" data-tone={checkTone(chk?.status)}>
                                {chk?.status || "—"}
                              </span>
                            </td>
                          );
                        })}
                        <td>
                          <span className="check-pill" data-tone={checkTone(node.overall)}>
                            {node.overall || "—"}
                          </span>
                          <button type="button" className="btn sanity-live-btn" onClick={() => setLiveNode((cur) => (cur === label ? null : label))}>
                            {liveNode === label ? "Hide" : "Live"}
                          </button>
                        </td>
                      </tr>
                      {liveNode === label ? (
                        <tr className="sanity-live">
                          <td colSpan={SANITY_COLS.length + 3}>
                            <pre>
                              {(node.log || []).join("\n") ||
                                (node.overall === "RUNNING" ? "Starting the checks…" : "No live log for this run.")}
                            </pre>
                            <ul>
                              {SANITY_COLS.map((c) => {
                                const chk = node.checks?.[c];
                                const line = (chk?.failures || []).join("; ") || chk?.detail || "";
                                if (!line) return null;
                                return (
                                  <li key={c}>
                                    <b>{c.toUpperCase()}</b> {line}
                                  </li>
                                );
                              })}
                            </ul>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
              </tbody>
            </table>
            {!Object.entries(sanity?.nodes || {}).some(([, node]) => hasSerial(node.serial)) ? (
              <p className="widget-empty">
                {sanity?.nodes && Object.keys(sanity.nodes).length
                  ? "No nodes with a serial on this rack."
                  : "No sanity results yet. Capture a golden BOM, then run sanity against the rack."}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {pane === "reports" ? (
      <section className="test-reports" data-mona="reports">
        <h2>Reports</h2>
        <p className="test-rep-blurb">L10 / L11 packets from the last sanity run, plus Argus rack files</p>
        <div className="sanity-tools" style={{ marginBottom: "0.7rem" }}>
          {mayEdit ? (
            <>
              <button type="button" className="btn btn-primary" disabled={reportBusy} onClick={() => void makeReport("L11")}>
                {reportBusy ? "Building…" : "Generate L11 rack PDF"}
              </button>
              <button type="button" className="btn" disabled={reportBusy} onClick={() => void makeReport("L10")}>
                Generate L10 node PDF
              </button>
            </>
          ) : null}
        </div>
        <div className="test-rep-stats">
          <div className="test-rep-stat">
            <span>Total</span>
            <b>{reports.length}</b>
          </div>
          <div className="test-rep-stat" data-kind="pdf">
            <span>PDF</span>
            <b>{pdfCount}</b>
          </div>
          <div className="test-rep-stat" data-kind="xlsx">
            <span>Excel</span>
            <b>{xlsCount}</b>
          </div>
          <div className="test-rep-stat" data-kind="json">
            <span>JSON</span>
            <b>{jsonCount}</b>
          </div>
        </div>
        <div className="test-rep-tools">
          <input
            type="search"
            value={reportQuery}
            onChange={(e) => setReportQuery(e.target.value)}
            placeholder="Search filename, rack, test run…"
            aria-label="Search reports"
          />
          <select value={reportType} onChange={(e) => setReportType(e.target.value)} aria-label="Filter report type">
            {reportTypes.map((t) => (
              <option key={t} value={t}>
                {t === "all" ? "All types" : t.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        {reportsError ? <p className="cluster-error">{reportsError}</p> : null}
        <div className="testing-table-wrap test-rep-table">
          <table className="testing-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Rack</th>
                <th>Type</th>
                <th>Created</th>
                <th>Test runs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredReports.map((r, i) => (
                <tr
                  key={`${r.path || r.serial_number}-${i}`}
                  className="test-rep-row"
                  data-kind={reportKind(r) || undefined}
                  onClick={() => {
                    if (r.path) void openReport(r);
                  }}
                >
                  <td>
                    <b>{reportName(r)}</b>
                  </td>
                  <td>
                    {r.serial_number ? <span className="test-rep-serial">{r.serial_number}</span> : "—"}
                  </td>
                  <td>
                    <span className="test-rep-type">{(reportKind(r) || "file").toUpperCase()}</span>
                  </td>
                  <td title={reportWhen(r.date_created)}>
                    {r.date_created ? ago(r.date_created) : "—"}
                  </td>
                  <td>{r.test_runs?.length ? r.test_runs.join(", ") : "—"}</td>
                  <td className="row-actions">
                    {r.path ? (
                      <>
                        <button
                          type="button"
                          className="btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openReport(r);
                          }}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void downloadReport(r).catch((err) =>
                              setPreviewErr(err instanceof Error ? err.message : "Download failed"),
                            );
                          }}
                        >
                          Download
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!reportsReady ? (
            <p className="widget-empty">Loading reports…</p>
          ) : filteredReports.length === 0 ? (
            <p className="widget-empty">
              {reports.length ? "No reports match that search" : "No Argus reports yet"}
            </p>
          ) : null}
        </div>
      </section>
      ) : null}
      {preview
        ? createPortal(
            <div
              className="scrim traveler-preview-scrim report-preview-scrim"
              onClick={(event) => {
                if (event.target === event.currentTarget) closePreview();
              }}
            >
              <div className="traveler-preview-dialog report-preview-dialog" role="dialog" aria-modal="true" aria-label={preview.title}>
                <header className="traveler-preview-head">
                  <strong>{preview.title}</strong>
                  {preview.url ? (
                    <a className="btn" href={preview.url} download={preview.filename}>
                      Download
                    </a>
                  ) : preview.path ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        void downloadReport({ path: preview.path, name: preview.filename }).catch((err) =>
                          setPreviewErr(err instanceof Error ? err.message : "Download failed"),
                        )
                      }
                    >
                      Download
                    </button>
                  ) : null}
                </header>
                {previewBusy ? (
                  <div className="traveler-preview-loading" role="status">
                    <p>Opening report…</p>
                  </div>
                ) : previewErr ? (
                  <div className="traveler-preview-loading" role="alert">
                    <p>{previewErr}</p>
                  </div>
                ) : preview.sheets?.length ? (
                  <div className="report-xlsx">
                    {preview.sheets.length > 1 ? (
                      <div className="report-xlsx-tabs" role="tablist" aria-label="Sheets">
                        {preview.sheets.map((s, i) => (
                          <button
                            key={`${s.name}-${i}`}
                            type="button"
                            role="tab"
                            aria-selected={sheet === i}
                            data-active={sheet === i}
                            onClick={() => setSheet(i)}
                          >
                            {s.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className="report-xlsx-grid">
                      <table>
                        <tbody>
                          {(preview.sheets[sheet] || preview.sheets[0]).rows.map((row, ri) => (
                            <tr key={ri} data-head={ri === 0}>
                              {row.map((cell, ci) => (
                                <td key={ci}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {preview.truncated ? <p className="report-xlsx-note">Showing the first sheets and rows</p> : null}
                  </div>
                ) : preview.text ? (
                  <pre className="report-preview-text">{preview.text}</pre>
                ) : preview.kind === "pdf" || preview.mime.includes("pdf") || /\.pdf$/i.test(preview.filename) ? (
                  <object title={preview.title} data={preview.url} type="application/pdf" className="traveler-preview-frame">
                    <p className="muted" style={{ padding: "1rem" }}>
                      PDF preview unavailable in this browser.{" "}
                      <a href={preview.url} download={preview.filename}>
                        Download the PDF
                      </a>
                      .
                    </p>
                  </object>
                ) : (
                  <div className="traveler-preview-loading">
                    <p>This file type opens as a download.</p>
                    {preview.url ? (
                      <a className="btn" href={preview.url} download={preview.filename}>
                        Save {preview.filename}
                      </a>
                    ) : null}
                  </div>
                )}
                <button type="button" className="image-viewer-close" onClick={closePreview} aria-label="Close report" title="Close (Esc)">
                  ×
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
