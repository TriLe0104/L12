import type {
  Campus,
  ClusterOverview,
  ClusterRack,
  ClusterWorkload,
  DataHall,
  HallDetail,
  MaxLpsInvGpu,
  MaxLpsInvNode,
  MaxLpsInvRack,
  MaxLpsInventory,
  MaxLpsInvShelf,
} from "./cluster";
import type {
  ActivityItem,
  Assignee,
  POComment,
  PODraft,
  PurchaseOrder,
  StaffTask,
  StaffTaskDraft,
  StageMeta,
  StatusMeta,
  User,
} from "./types";
import type { BoardSettings } from "./boardTypes";

function defaultApiBase() {
  // Browser always uses same-origin /api so login works on the PXE host without
  // opening :8001 (Next rewrites to the API). Direct 127.0.0.1:8001 fails off-box.
  if (typeof window !== "undefined") return "";
  return (process.env.API_PROXY || process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8001").replace(/\/$/, "");
}

export const API_BASE = defaultApiBase();

const TOKEN_KEY = "po_calendar_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/** Uploaded assets are either API-relative (`/uploads/ab12.png`) or absolute
 *  object-storage URLs when `S3_PUBLIC_BASE_URL` is set on the API. */
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith("/") ? `${API_BASE}${path}` : path;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") {
        detail = body.detail;
      } else if (Array.isArray(body.detail)) {
        detail = body.detail
          .map((row: { loc?: unknown[]; msg?: string }) => {
            const loc = Array.isArray(row.loc) ? row.loc.filter((x) => x !== "body").join(".") : "";
            return `${loc ? loc + ": " : ""}${row.msg || "invalid"}`;
          })
          .join("; ");
      } else if (body.detail) {
        detail = JSON.stringify(body.detail);
      }
    } catch {
      /* non-json error */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ access_token: string; user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  authConfig: () =>
    request<{ provider: string; allow_signup: boolean }>("/api/auth/config"),
  me: () => request<User>("/api/auth/me"),

  agentStatus: () =>
    request<{
      enabled: boolean;
      configured?: boolean;
      online?: boolean;
      hint: string | null;
      model: string | null;
      can_edit: boolean;
    }>("/api/agent/status"),
  agentChat: (
    messages: { role: "user" | "assistant"; content: string }[],
    context?: {
      path?: string;
      execute?: { tool: string; arguments?: Record<string, unknown>; label?: string };
      attachment_ids?: string[];
    },
  ) =>
    request<{
      reply: string;
      enabled: boolean;
      actions: { name: string; ok: boolean; summary: string }[];
      choices: {
        label: string;
        tool: string;
        arguments?: Record<string, unknown>;
        hint?: string | null;
        mutating?: boolean;
      }[];
      mutated: boolean;
      model: string | null;
      ui?: {
        kind: string;
        path?: string;
        target?: string;
        value?: string;
        submit?: boolean;
        action?: string;
        label?: string;
        ids?: string[];
        refresh?: string;
        node?: string;
        host?: string;
        user?: string;
        command?: string;
        stdout?: string;
        stderr?: string;
        exit?: number | null;
        error?: string | null;
        ok?: boolean;
      }[];
    }>("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({
        messages,
        context: context?.path ? { path: context.path } : undefined,
        execute: context?.execute,
        attachment_ids: context?.attachment_ids?.length ? context.attachment_ids : undefined,
      }),
    }),
  agentJobs: () =>
    request<{
      jobs: {
        id: string;
        name: string;
        kind: string;
        status: string;
        doing: string | null;
        test?: string | null;
        rack?: string | null;
        serial?: string | null;
        ok?: boolean | null;
        error?: string | null;
        started_at?: string | null;
        finished_at?: string | null;
        log?: string[];
        chat?: { id: string; kind?: string; text: string; at?: string }[];
        minion?: string | null;
        mission?: string | null;
        briefing?: string | null;
        debrief?: string | null;
        debrief_id?: string | null;
      }[];
      running: number;
    }>("/api/agent/jobs"),
  stopAgentJob: (id: string) =>
    request<{
      ok: boolean;
      id?: string;
      name?: string;
      status?: string;
      doing?: string;
      error?: string;
    }>(`/api/agent/jobs/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  uploadAgentAttachment: (file: File) =>
    postFile<{
      id: string;
      filename: string;
      kind: string;
      mime: string;
      chars: number;
      url: string;
      created_at: string;
    }>("/api/agent/attachments", file),
  agentConsole: (node: string, command: string, via?: "os" | "bmc") =>
    request<{
      ok: boolean;
      os_ip?: string | null;
      user?: string;
      via?: string;
      exit?: number;
      stdout?: string;
      stderr?: string;
      error?: string;
      ui?: Record<string, unknown>;
    }>("/api/agent/console", {
      method: "POST",
      body: JSON.stringify(via ? { node, command, via } : { node, command }),
    }),
  setAgentKey: (key: string) =>
    request<{ configured: boolean; hint: string | null }>("/api/agent/key", {
      method: "PUT",
      body: JSON.stringify({ key }),
    }),
  agentDocs: () =>
    request<{ id: string; title: string; filename: string; chars: number; created_at: string }[]>(
      "/api/agent/docs",
    ),
  uploadAgentDoc: (file: File, title?: string) =>
    postFile<{ id: string; title: string; filename: string; chars: number }>(
      "/api/agent/docs",
      file,
      title ? { title } : undefined,
    ),
  deleteAgentDoc: (id: string) =>
    request<{ ok: boolean }>(`/api/agent/docs/${encodeURIComponent(id)}`, { method: "DELETE" }),

  clusterOverview: () => request<ClusterOverview>("/api/cluster/overview"),
  patchClusterName: (name: string) =>
    request<{ name: string }>("/api/cluster/name", {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  clusterMetrics: (params: { range?: string; from_ts?: number; to_ts?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.range) qs.set("range", params.range);
    if (params.from_ts != null) qs.set("from_ts", String(params.from_ts));
    if (params.to_ts != null) qs.set("to_ts", String(params.to_ts));
    const q = qs.toString();
    return request<import("./cluster").ClusterMetrics>(`/api/cluster/metrics${q ? `?${q}` : ""}`);
  },
  clusterHealth: () => request<import("./cluster").ClusterHealth>("/api/cluster/health"),
  clusterHealthNode: (bmcIp: string) =>
    request<import("./cluster").ClusterHealthNode>(
      `/api/cluster/health/node?bmc_ip=${encodeURIComponent(bmcIp)}`,
    ),
  nodePower: (bmcIp: string, resetType: string) =>
    request<{ ok: boolean; bmc_ip?: string; reset_type?: string; error?: string }>(
      "/api/cluster/health/node/power",
      { method: "POST", body: JSON.stringify({ bmc_ip: bmcIp, reset_type: resetType }) },
    ),
  testCatalog: () =>
    request<{
      source: string;
      error?: string | null;
      components: { id: string; label: string; blurb: string; count?: number }[];
      tests: {
        id: string;
        name: string;
        label: string;
        detail: string;
        component: string;
        classifier?: string | null;
        timeout_seconds?: number | null;
        subtests?: { id: string; label: string }[];
        source: string;
        kind: string;
        gpu_request: number;
        gpu_mem_gb_request: number;
        pods_requested: number;
      }[];
    }>("/api/tests/catalog"),
  testRuns: () => request<{ active_runs?: unknown[]; error?: string }>("/api/tests/runs"),
  testReports: (params: { serial?: string; name?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.serial) qs.set("serial", params.serial);
    if (params.name) qs.set("name", params.name);
    const q = qs.toString();
    return request<{
      reports: {
        serial_number?: string;
        type?: string;
        path?: string;
        name?: string;
        date_created?: string;
        test_runs?: (string | number)[];
      }[];
      count: number;
      error?: string | null;
    }>(`/api/tests/reports${q ? `?${q}` : ""}`);
  },
  testReportPreview: (path: string) =>
    request<{
      kind: "pdf" | "xlsx" | "json" | "text" | "file" | string;
      filename: string;
      mime?: string;
      text?: string;
      sheets?: { name: string; rows: string[][] }[];
      truncated?: boolean;
    }>(`/api/tests/preview?path=${encodeURIComponent(path)}`),
  testLogs: (params: { bmc_mac?: string; path?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.bmc_mac) qs.set("bmc_mac", params.bmc_mac);
    if (params.path) qs.set("path", params.path);
    const q = qs.toString();
    return request<unknown>(`/api/tests/logs${q ? `?${q}` : ""}`);
  },
  testReportFile: async (path: string) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/api/tests/file?path=${encodeURIComponent(path)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        /* non-json */
      }
      throw new ApiError(res.status, detail);
    }
    const mime = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    const disp = res.headers.get("content-disposition") || "";
    const named = /filename="?([^";]+)"?/i.exec(disp)?.[1];
    const blob = await res.blob();
    return { blob, mime, filename: named || path.split(/[/\\]/).pop() || "report" };
  },
  runArgusTest: (payload: { tests: string[]; rack_serial?: string; rack_name?: string; node_macs?: string[] }) =>
    request<{ ok: boolean; result?: unknown }>("/api/tests/run", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  sanityStatus: (serial?: string) =>
    request<{
      status?: string;
      overall?: string | null;
      rack_serial?: string | null;
      rack_label?: string | null;
      started_at?: string | null;
      finished_at?: string | null;
      result_file?: string;
      nodes?: Record<
        string,
        {
          label?: string;
          serial?: string | null;
          hostname?: string | null;
          overall?: string;
          timestamp?: string | null;
          skip_reason?: string | null;
          checks?: Record<string, { status?: string; failures?: string[]; detail?: string }>;
        }
      >;
      checks?: { id: string; label: string; blurb: string }[];
      golden?: Record<string, { exists: boolean; filename: string; mtime: string | null; bytes?: number }> & {
        capture?: { running?: boolean; error?: string | null; finished_at?: string | null; node?: string | null };
      };
      job?: { running?: boolean; job_id?: string | null; kind?: string | null };
      error?: string;
    }>(`/api/tests/sanity${serial ? `?serial=${encodeURIComponent(serial)}` : ""}`),
  runSanity: (payload: { rack_serial?: string; rack_name?: string; node_macs?: string[]; checks?: string[] } = {}) =>
    request<Record<string, unknown>>("/api/tests/sanity/run", { method: "POST", body: JSON.stringify(payload) }),
  stopSanity: () => request<{ stopped: boolean }>("/api/tests/sanity/stop", { method: "POST" }),
  goldenStatus: () =>
    request<Record<string, { exists: boolean; filename: string; mtime: string | null; bytes?: number }>>("/api/tests/golden"),
  goldenFile: (kind: string) =>
    request<{ kind: string; content: unknown; filename?: string; exists?: boolean }>("/api/tests/golden/" + encodeURIComponent(kind)),
  saveGolden: (kind: string, content: unknown) =>
    request<{ ok: boolean; kind: string }>(`/api/tests/golden/${encodeURIComponent(kind)}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  captureGolden: (payload: { rack_serial?: string; rack_name?: string; node?: string } = {}) =>
    request<{ ok: boolean; node?: { serial?: string; hostname?: string; label?: string }; golden?: Record<string, unknown> }>(
      "/api/tests/golden/capture",
      { method: "POST", body: JSON.stringify(payload) },
    ),
  l11Scripts: () =>
    request<{
      source: string;
      scripts: { id: string; label: string; component: string; detail: string; present?: boolean; source?: string }[];
    }>("/api/tests/l11-scripts"),
  l11Script: (id: string) => request<{ id: string; filename: string; content: string }>(`/api/tests/l11-scripts/${encodeURIComponent(id)}`),
  runL11Script: (id: string, payload: { rack_serial?: string; rack_name?: string; node?: string; timeout?: number } = {}) =>
    request<{ ok: boolean; exit?: number; stdout?: string; stderr?: string; error?: string; log?: string }>(
      `/api/tests/l11-scripts/${encodeURIComponent(id)}/run`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  generateL11Report: (payload: { level?: string; rack_serial?: string; node_serial?: string } = {}) =>
    request<{
      ok: boolean;
      level: string;
      pdf: string;
      csv: string;
      json: string;
      path: string;
      overall?: string;
      rack_serial?: string;
      rack_label?: string;
    }>("/api/tests/l11-report", { method: "POST", body: JSON.stringify(payload) }),
  l11Reports: () =>
    request<{
      reports: {
        name: string;
        path: string;
        type: string;
        date_created?: string;
        test_runs?: string[];
        source?: string;
      }[];
      count: number;
    }>("/api/tests/l11-reports"),
  provision: (opts?: { sync?: boolean }) =>
    request<import("./cluster").ProvisionSnapshot>(
      `/api/provision${opts?.sync === false ? "?sync=false" : ""}`,
    ),
  provisionRegister: (serials: string[]) =>
    request<import("./cluster").ProvisionSnapshot>("/api/provision/register", {
      method: "POST",
      body: JSON.stringify({ serials }),
    }),
  provisionDiscover: () =>
    request<import("./cluster").ProvisionSnapshot>("/api/provision/discover", { method: "POST" }),
  provisionRedfish: (ids: string[]) =>
    request<import("./cluster").ProvisionSnapshot>("/api/provision/redfish", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  provisionPxe: (ids: string[]) =>
    request<import("./cluster").ProvisionSnapshot>("/api/provision/pxe", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  provisionConsole: (id: string) =>
    request<{ id: string; name: string; status: string; log: string; needs_hop?: boolean; hop?: import("./cluster").ProvisionHop; bmc_ip?: string | null }>(
      `/api/provision/nodes/${id}/console`,
    ),
  provisionPxeServers: () =>
    request<{ servers: { id: string; name: string; host: string; username: string; password?: string | null }[] }>(
      "/api/provision/pxe-servers",
    ),
  provisionSavePxeServers: (
    servers: { id: string; name: string; host: string; username: string; password?: string }[],
  ) =>
    request<{ servers: { id: string; name: string; host: string; username: string; password?: string | null }[] }>(
      "/api/provision/pxe-servers",
      { method: "PUT", body: JSON.stringify({ servers }) },
    ),
  provisionHop: () => request<import("./cluster").ProvisionHop>("/api/provision/hop"),
  provisionHopConnect: (payload: { host?: string; username?: string; password?: string }) =>
    request<import("./cluster").ProvisionHop>("/api/provision/hop", { method: "POST", body: JSON.stringify(payload) }),
  provisionHopCheck: (payload: { host: string; username?: string; password?: string }) =>
    request<{ reachable: boolean; authenticated: boolean; detail?: string }>("/api/provision/hop/check", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  provisionHopClose: () =>
    request<import("./cluster").ProvisionHop>("/api/provision/hop", { method: "DELETE" }),
  provisionAddNode: (payload: {
    bmc_mac?: string;
    bmc_user?: string;
    bmc_password?: string;
    bmc_ip?: string;
    os_ip?: string;
    os_username?: string;
    os_password?: string;
    pxe_server?: string;
    os_mac?: string;
    serial?: string;
    name?: string;
    hall_name?: string;
  }) =>
    request<
      import("./cluster").ProvisionSnapshot & {
        added: import("./cluster").InventoryNode;
        created?: boolean;
        filled?: Record<string, unknown>;
      }
    >("/api/provision/nodes", { method: "POST", body: JSON.stringify(payload) }),
  provisionDeleteRack: (id: string) =>
    request<
      import("./cluster").ProvisionSnapshot & {
        removed?: { ok: boolean; id: string; label: string; nodes: number; hidden: boolean };
      }
    >(`/api/provision/racks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  provisionPatchNode: (id: string, payload: Record<string, string | undefined>) =>
    request<
      import("./cluster").ProvisionSnapshot & {
        added: import("./cluster").InventoryNode;
        filled?: Record<string, unknown>;
      }
    >(`/api/provision/nodes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  provisionEnrichNode: (id: string) =>
    request<
      import("./cluster").ProvisionSnapshot & {
        added: import("./cluster").InventoryNode;
        filled?: Record<string, unknown>;
      }
    >(`/api/provision/nodes/${encodeURIComponent(id)}/enrich`, { method: "POST" }),
  provisionFindIp: (id: string) =>
    request<{ id: string; bmc_mac: string; bmc_ip: string | null; ip: string | null; matches: { ip: string; source: string }[] }>(
      `/api/provision/nodes/${encodeURIComponent(id)}/find-ip`,
      { method: "POST" },
    ),
  provisionKvm: (id: string, view: "kvm" | "sol" | "bmc" = "kvm") =>
    request<{
      id: string;
      name: string;
      bmc_ip: string;
      path: string;
      view?: string;
      url: string;
      sol_url: string;
      bmc_url?: string;
      via: string;
      user?: string;
    }>(
      `/api/provision/nodes/${encodeURIComponent(id)}/kvm?view=${encodeURIComponent(view)}`,
      { method: "POST" },
    ),
  provisionSync: () => request<import("./cluster").ProvisionSnapshot>("/api/provision/sync", { method: "POST" }),
  fabric: () => request<import("./cluster").FabricTopology>("/api/fabric"),
  fabricPorts: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    ).toString();
    return request<{ count: number; ports: import("./cluster").FabricPort[]; summary: import("./cluster").FabricSummary }>(
      `/api/fabric/ports${qs ? `?${qs}` : ""}`,
    );
  },
  fabricLive: (node?: string) =>
    request<import("./cluster").LiveTraffic>(
      node ? `/api/fabric/live?node=${encodeURIComponent(node)}` : "/api/fabric/live",
    ),
  campus: () => request<Campus>("/api/cluster/campus"),
  clusterPower: () => request<import("./cluster").PowerLimiter>("/api/cluster/power"),
  maxlps: (params: { top?: number; rack_id?: string | null; gpu_id?: string | null } = {}) => {
    const qs = new URLSearchParams();
    if (params.top != null) qs.set("top", String(params.top));
    if (params.rack_id) qs.set("rack_id", params.rack_id);
    if (params.gpu_id) qs.set("gpu_id", params.gpu_id);
    const q = qs.toString();
    return request<import("./cluster").MaxLpsView>(`/api/cluster/maxlps${q ? `?${q}` : ""}`);
  },
  maxlpsRanking: () =>
    request<{
      source: string;
      gpu_poll_age_s: number | null;
      gpus: {
        id: string;
        watts: number;
        setpoint_w?: number | null;
        min_w?: number | null;
        max_w?: number | null;
        rank: number;
      }[];
    }>("/api/cluster/maxlps/ranking"),
  loopTargets: () => request<import("./cluster").LoopTargets>("/api/cluster/maxlps/loop"),
  patchLoopTargets: (payload: {
    racks?: { id: string; on: boolean }[];
    nodes?: { id: string; on: boolean }[];
  }) =>
    request<import("./cluster").LoopTargets>("/api/cluster/maxlps/loop", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  maxlpsGpuCurve: (gpuId: string) =>
    request<{
      id: string;
      watts: number;
      setpoint_w: number;
      min_w: number;
      max_w: number;
      process?: string;
      workload?: string;
      workload_kind?: string;
      pid?: number;
      curve: { t: number; w: number; cap: number; min?: number; max?: number }[];
      cap_posts?: number;
      cap_fails?: number;
      cap_fail_pct?: number;
      cap_ms?: number | null;
      read_ms?: number | null;
    }>(`/api/cluster/maxlps/gpus/${encodeURIComponent(gpuId)}/curve`),
  patchMaxlpsGpu: (gpuId: string, payload: { min_w?: number; max_w?: number }) =>
    request<import("./cluster").MaxLpsView>(`/api/cluster/maxlps/gpus/${encodeURIComponent(gpuId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  maxlpsInventory: (sync = false) =>
    request<MaxLpsInventory>(`/api/maxlps/inventory${sync ? "?sync=true" : ""}`),
  syncMaxlpsInventory: () =>
    request<
      MaxLpsInventory & {
        ok: boolean;
        created?: number;
        updated?: number;
        removed?: number;
        serials?: string[];
        ok_pxes?: string[];
        errors?: string[];
      }
    >("/api/maxlps/sync", {
      method: "POST",
    }),
  maxlpsSchema: () => request<Record<string, unknown>>("/api/maxlps/schema"),
  createMaxlpsRack: (payload: {
    label: string;
    serial?: string;
    hall?: string;
    notes?: string;
    model?: string;
    node?: Partial<MaxLpsInvNode> & { index?: number };
  }) => request<MaxLpsInvRack>("/api/maxlps/racks", { method: "POST", body: JSON.stringify(payload) }),
  assignMaxlpsNode: (rackId: string, payload: Partial<MaxLpsInvNode> & { index?: number }) =>
    request<MaxLpsInvNode>(`/api/maxlps/racks/${encodeURIComponent(rackId)}/nodes`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  patchMaxlpsRack: (
    id: string,
    payload: Partial<{ label: string; serial: string | null; hall: string | null; notes: string | null; model: string; enabled: boolean; power_state: string }>,
  ) => request<MaxLpsInvRack>(`/api/maxlps/racks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteMaxlpsRack: (id: string) => request<{ ok: boolean; id: string }>(`/api/maxlps/racks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  patchMaxlpsNode: (id: string, payload: Partial<MaxLpsInvNode>) =>
    request<MaxLpsInvNode>(`/api/maxlps/nodes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  patchMaxlpsShelf: (id: string, payload: Partial<MaxLpsInvShelf>) =>
    request<MaxLpsInvShelf>(`/api/maxlps/shelves/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  patchMaxlpsInvGpu: (id: string, payload: Partial<MaxLpsInvGpu>) =>
    request<MaxLpsInvGpu>(`/api/maxlps/gpus/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  maxlpsWatts: (params?: { since?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.since) qs.set("since", params.since);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return request<{ samples: Record<string, unknown>[] }>(`/api/maxlps/watts${q ? `?${q}` : ""}`);
  },
  maxlpsRackWatts: (rackId: string, params?: { since?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.since) qs.set("since", params.since);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return request<{ rack_id: string; samples: Record<string, unknown>[] }>(
      `/api/maxlps/watts/racks/${encodeURIComponent(rackId)}${q ? `?${q}` : ""}`,
    );
  },
  patchClusterPower: (payload: {
    mode?: string;
    budget_kw?: number;
    auto_budget?: boolean;
    reset?: boolean;
    max_rack_kw?: number;
    max_hall_kw?: number;
    max_pod_kw?: number;
    stay_under_pct?: number;
    total_budget_kw?: number;
    rack_count?: number;
    min_rack_kw?: number;
    interval_s?: number;
    gpu_power_percent?: number;
    desired_cap_percent?: number;
    gpu_min_w?: number;
    gpu_max_w?: number;
  }) =>
    request<import("./cluster").PowerLimiter>("/api/cluster/power", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  getRack: (id: string) => request<ClusterRack>(`/api/cluster/racks/${id}`),
  listWorkloads: () => request<ClusterWorkload[]>("/api/workloads"),
  createWorkload: (payload: Partial<ClusterWorkload> & { name: string }) =>
    request<ClusterWorkload>("/api/workloads", { method: "POST", body: JSON.stringify(payload) }),
  updateWorkload: (id: string, payload: Partial<ClusterWorkload>) =>
    request<ClusterWorkload>(`/api/workloads/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteWorkload: (id: string) => request<void>(`/api/workloads/${id}`, { method: "DELETE" }),
  listHalls: () => request<DataHall[]>("/api/cluster/halls"),
  getHall: (id: string) => request<HallDetail>(`/api/cluster/halls/${id}`),
  createHall: (payload: { name: string; description?: string; width_tiles?: number; depth_tiles?: number }) =>
    request<HallDetail>("/api/cluster/halls", { method: "POST", body: JSON.stringify(payload) }),
  updateHall: (id: string, payload: Partial<{ name: string; description: string; width_tiles: number; depth_tiles: number }>) =>
    request<DataHall>(`/api/cluster/halls/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteHall: (id: string) => request<void>(`/api/cluster/halls/${id}`, { method: "DELETE" }),
  createRack: (hallId: string, payload: { name: string; x: number; y: number; rotation?: number; height_u?: number }) =>
    request<ClusterRack>(`/api/cluster/halls/${hallId}/racks`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createRacksBulk: (
    hallId: string,
    payload: { cols: number; rows: number; count?: number; prefix?: string; aisle?: boolean },
  ) =>
    request<ClusterRack[]>(`/api/cluster/halls/${hallId}/racks/bulk`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  patchRacksBulk: (payload: { ids: string[]; power_state?: string; run_status?: string; delete?: boolean }) =>
    request<{ deleted?: number; racks?: ClusterRack[] }>("/api/cluster/racks/bulk", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateRack: (id: string, payload: Partial<{ name: string; x: number; y: number; rotation: number; height_u: number; notes: string | null; power_state: string; run_status: string }>) =>
    request<ClusterRack>(`/api/cluster/racks/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteRack: (id: string) => request<void>(`/api/cluster/racks/${id}`, { method: "DELETE" }),
  createDevice: (rackId: string, payload: { name: string; kind?: string; status?: string; u_start: number; u_height?: number; check_value?: string }) =>
    request(`/api/cluster/racks/${rackId}/devices`, { method: "POST", body: JSON.stringify(payload) }),
  updateDevice: (id: string, payload: Record<string, unknown>) =>
    request(`/api/cluster/devices/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteDevice: (id: string) => request<void>(`/api/cluster/devices/${id}`, { method: "DELETE" }),


  listPOs: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    ).toString();
    return request<PurchaseOrder[]>(`/api/purchase-orders${qs ? `?${qs}` : ""}`);
  },
  createPO: (payload: PODraft) =>
    request<PurchaseOrder>("/api/purchase-orders", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updatePO: (id: string, payload: PODraft) =>
    request<PurchaseOrder>(`/api/purchase-orders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deletePO: (id: string) =>
    request<void>(`/api/purchase-orders/${id}`, { method: "DELETE" }),
  poActivity: (id: string) => request<ActivityItem[]>(`/api/purchase-orders/${id}/activity`),
  listComments: (id: string, part?: number | null | "all") =>
    request<POComment[]>(
      `/api/purchase-orders/${id}/comments${
        part === "all" ? "?all=1" : part ? `?part=${part}` : ""
      }`,
    ),
  addComment: (id: string, body: string, part?: number | null | "all") =>
    request<POComment>(`/api/purchase-orders/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body,
        part_index: part === "all" || part == null ? null : part - 1,
      }),
    }),
  deleteComment: (poId: string, commentId: string) =>
    request<void>(`/api/purchase-orders/${poId}/comments/${commentId}`, {
      method: "DELETE",
    }),

  listUsers: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    ).toString();
    return request<User[]>(`/api/users${qs ? `?${qs}` : ""}`);
  },
  createUser: (payload: Partial<User> & { password?: string }) =>
    request<User>("/api/users", { method: "POST", body: JSON.stringify(payload) }),
  updateUser: (id: string, payload: Partial<User> & { password?: string }) =>
    request<User>(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteUser: (id: string) => request<void>(`/api/users/${id}`, { method: "DELETE" }),
  userActivity: (id: string) => request<ActivityItem[]>(`/api/users/${id}/activity`),
  orgs: () => request<string[]>("/api/users/orgs"),
  /** Just enough about each person to draw the owner picker. */
  assignableUsers: () => request<Assignee[]>("/api/users/assignable"),

  listStaffTasks: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    ).toString();
    return request<StaffTask[]>(`/api/staff-tasks${qs ? `?${qs}` : ""}`);
  },
  createStaffTask: (payload: StaffTaskDraft) =>
    request<StaffTask>("/api/staff-tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateStaffTask: (id: string, payload: Partial<StaffTaskDraft>) =>
    request<StaffTask>(`/api/staff-tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteStaffTask: (id: string) =>
    request<void>(`/api/staff-tasks/${id}`, { method: "DELETE" }),

  statuses: () => request<StatusMeta[]>("/api/meta/statuses"),
  stages: () => request<StageMeta[]>("/api/meta/stages"),

  boardSettings: () => request<BoardSettings>("/api/settings/board"),
  saveBoardSettings: (document: BoardSettings["document"]) =>
    request<BoardSettings>("/api/settings/board", {
      method: "PUT",
      body: JSON.stringify({ document }),
    }),

  uploadImage: (file: File) => postFile<{ url: string; filename: string }>("/api/uploads", file),
  addPart: (poId: string, payload: Record<string, any>) =>
    request<PurchaseOrder>(`/api/purchase-orders/${poId}/parts`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  setDisplayPart: (poId: string, index: number) =>
    request<PurchaseOrder>(`/api/purchase-orders/${poId}/display-part`, {
      method: "PATCH",
      body: JSON.stringify({ index }),
    }),
  patchPart: (poId: string, index: number, payload: Record<string, any>) =>
    request<PurchaseOrder>(`/api/purchase-orders/${poId}/parts/${index}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  updatePOWithPart: (
    poId: string,
    poFields: Record<string, any> | null,
    partIndex: number | null,
    partPayload: Record<string, any> | null,
  ) =>
    request<PurchaseOrder>(`/api/purchase-orders/${poId}/with-part`, {
      method: "PATCH",
      body: JSON.stringify({ fields: poFields ?? {}, part_index: partIndex, part: partPayload ?? {} }),
    }),

  /** Your own profile photo, stored and applied in one call. Open to every rank,
   *  because it can only ever write the caller's own avatar; returns the updated
   *  account. Setting someone *else's* photo is uploadImage + updateUser. */
  uploadOwnAvatar: (file: File) => postFile<User>("/api/uploads/avatar", file),

  /** A 3D model for the order's single model slot. The server validates the
   *  extension against the file's leading bytes and rejects anything else. */
  uploadModel: (file: File) =>
    postFile<{ url: string; filename: string; size: number; format: string }>(
      "/api/uploads/model",
      file,
    ),

  /** Merged traveler field map for the editable packet editor. `part` is 1-based. */
  getTraveler: (poId: string, part?: number | null) =>
    request<{
      fields: Record<string, string | number | null>;
      saved: Record<string, unknown> | null;
      detached: string[];
    }>(`/api/purchase-orders/${poId}/traveler${part ? `?part=${part}` : ""}`),
  /** Get a single PO by id. */
  getPO: (poId: string) => request<PurchaseOrder>(`/api/purchase-orders/${poId}`),

  /** Persist traveler_draft JSON for one part (editor floor). `part` is 1-based. */
  saveTraveler: (
    poId: string,
    fields: Record<string, string | number | null>,
    part?: number | null,
    detached?: string[],
  ) =>
    request<{
      fields: Record<string, string | number | null>;
      saved: Record<string, unknown> | null;
      detached: string[];
    }>(`/api/purchase-orders/${poId}/traveler${part ? `?part=${part}` : ""}`, {
      method: "PUT",
      body: JSON.stringify({ fields, detached: detached ?? [] }),
    }),

  /** Silent preview fetch (no activity). */
  previewTraveler: (poId: string, fmt: PacketFmt, opts?: { part?: number; signal?: AbortSignal }) => {
    const qs = opts?.part ? `?part=${opts.part}` : "";
    return fetchBinary(`/api/purchase-orders/${poId}/traveler/${fmt}${qs}`, fmt, {
      method: "GET",
      signal: opts?.signal,
    });
  },

  /** Download packet and record “Traveler generated”. */
  generateTraveler: (
    poId: string,
    fmt: PacketFmt,
    body?: {
      fields?: Record<string, string | number | null>;
      detached?: string[];
      persist?: boolean;
    },
    opts?: { part?: number; signal?: AbortSignal },
  ) => {
    const qs = opts?.part ? `?part=${opts.part}` : "";
    return fetchBinary(`/api/purchase-orders/${poId}/traveler/${fmt}${qs}`, fmt, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      headers: { "Content-Type": "application/json" },
      signal: opts?.signal,
    });
  },
};

/** Multipart upload. Deliberately not routed through `request`, which forces a
 *  JSON content type; the boundary has to come from FormData. */
async function postFile<T>(path: string, file: File, fields?: Record<string, string>): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  if (fields) {
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
  }
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {
      /* non-json error */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export type PacketFmt = "pdf" | "docx" | "xlsx";

/** Word / Excel only open these files when the MIME type matches the extension. */
const PACKET_MIME: Record<PacketFmt, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

/** The extension drives what the OS opens the download with, so it must always
 *  match the requested format even when the server name is missing or odd. */
function packetFilename(served: string | null, fmt: PacketFmt): string {
  const base = served?.split(/[\\/]/).pop()?.trim();
  if (!base) return `traveler.${fmt}`;
  return base.toLowerCase().endsWith(`.${fmt}`) ? base : `${base}.${fmt}`;
}

/** Binary traveler / export downloads. */
async function fetchBinary(
  path: string,
  fmt: PacketFmt,
  init: RequestInit = {},
): Promise<{ blob: Blob; filename: string }> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {
      /* non-json error */
    }
    throw new ApiError(res.status, detail);
  }
  const raw = await res.blob();
  const servedType = res.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  const type =
    servedType && servedType !== "application/octet-stream"
      ? servedType
      : PACKET_MIME[fmt];
  const blob = raw.type === type ? raw : new Blob([raw], { type });
  // Cross-origin reads need Access-Control-Expose-Headers: Content-Disposition;
  // fall back to a format-correct name rather than an unopenable one.
  const filename = packetFilename(
    filenameFromDisposition(res.headers.get("Content-Disposition")),
    fmt,
  );
  return { blob, filename };
}
