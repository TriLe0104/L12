export type DeviceKind = "compute" | "switch" | "power" | "empty";
export type DeviceStatus = "healthy" | "warning" | "critical" | "offline" | "empty";

export interface ClusterDevice {
  id: string;
  rack_id: string;
  name: string;
  kind: DeviceKind | string;
  status: DeviceStatus | string;
  u_start: number;
  u_height: number;
  last_check_at: string | null;
  check_value: string | null;
}

export type PowerState = "on" | "off";
export type RunStatus = "idle" | "running" | "ready";

export interface ClusterRack {
  id: string;
  hall_id: string;
  name: string;
  x: number;
  y: number;
  rotation: number;
  height_u: number;
  notes: string | null;
  power_state: PowerState | string;
  run_status: RunStatus | string;
  cpu_pct: number;
  gpu_pct: number;
  mem_pct: number;
  power_pct: number;
  power_kw: number;
  created_at: string;
  updated_at: string;
  devices: ClusterDevice[];
}

export interface DataHall {
  id: string;
  name: string;
  description: string | null;
  width_tiles: number;
  depth_tiles: number;
  created_at: string;
  updated_at: string;
  rack_count: number;
}

export interface Telemetry {
  cpu_pct: number;
  gpu_pct: number;
  mem_pct: number;
  power_kw: number;
  racks_on: number;
  racks_total: number;
}

export interface HallDetail extends DataHall {
  racks: ClusterRack[];
  telemetry?: Telemetry;
}

export interface Campus {
  name: string;
  telemetry: Telemetry;
  halls: HallDetail[];
}

export interface ClusterOverview {
  name?: string;
  halls: number;
  racks: number;
  devices: number;
  occupied_u: number;
  total_u: number;
  utilization_pct: number;
  cpu_pct?: number;
  gpu_pct?: number;
  mem_pct?: number;
  power_kw?: number;
  device_status: Record<string, number>;
  resources: Record<string, number>;
  rack_power: Record<string, number>;
  rack_run: Record<string, number>;
  health_checks: {
    entity: string;
    name: string;
    value: string;
    last_check: string | null;
    status: string;
  }[];
}

export const KIND_LABEL: Record<string, string> = {
  compute: "Compute",
  switch: "Switch",
  power: "Power",
  empty: "Empty",
};

export const STATUS_LABEL: Record<string, string> = {
  healthy: "Healthy",
  warning: "Warning",
  critical: "Critical",
  offline: "Offline",
  empty: "Empty",
};

export const RUN_LABEL: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  ready: "Ready",
};

export const POWER_LABEL: Record<string, string> = {
  on: "On",
  off: "Off",
};

export const GB300_ELEVATION: ClusterDevice[] = [
  { id: "cdu", rack_id: "", name: "CDU", kind: "power", status: "healthy", u_start: 1, u_height: 4, last_check_at: null, check_value: "OK" },
  { id: "nv1", rack_id: "", name: "NVLINK-1", kind: "switch", status: "healthy", u_start: 6, u_height: 2, last_check_at: null, check_value: "OK" },
  { id: "g1", rack_id: "", name: "GB300-T1", kind: "compute", status: "healthy", u_start: 9, u_height: 8, last_check_at: null, check_value: "OK" },
  { id: "g2", rack_id: "", name: "GB300-T2", kind: "compute", status: "healthy", u_start: 18, u_height: 8, last_check_at: null, check_value: "OK" },
  { id: "nv2", rack_id: "", name: "NVLINK-2", kind: "switch", status: "healthy", u_start: 27, u_height: 2, last_check_at: null, check_value: "OK" },
  { id: "g3", rack_id: "", name: "GB300-T3", kind: "compute", status: "healthy", u_start: 30, u_height: 8, last_check_at: null, check_value: "OK" },
  { id: "g4", rack_id: "", name: "GB300-T4", kind: "compute", status: "healthy", u_start: 39, u_height: 8, last_check_at: null, check_value: "OK" },
  { id: "bus", rack_id: "", name: "BUSBAR", kind: "power", status: "healthy", u_start: 47, u_height: 2, last_check_at: null, check_value: "OK" },
];

export function formatKw(kw: number): string {
  if (kw >= 1000) return `${(kw / 1000).toFixed(2)} MW`;
  return `${kw.toFixed(0)} kW`;
}

export interface ClusterWorkload {
  id: string;
  name: string;
  kind: string;
  status: string;
  project: string;
  department: string;
  node_pool: string | null;
  pods_running: number;
  pods_requested: number;
  gpu_request: number;
  gpu_allocation: number;
  gpu_mem_gb_request: number;
  gpu_mem_gb_alloc: number;
  detail: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const WORKLOAD_KIND_LABEL: Record<string, string> = {
  mlperf: "MLPerf",
  inference: "Inference",
  training: "Training",
  workspace: "Workspace",
  network: "Network",
  nccl: "NCCL",
};

export type FabricRole = "spine" | "leaf" | "rack";

export interface FabricNode {
  id: string;
  name: string;
  label: string;
  role: FabricRole | string;
  hall_id: string | null;
  hall_name: string | null;
  row?: number | null;
  rack_id?: string;
  ports: number;
  power_state?: string;
}

export interface FabricLink {
  id: string;
  from_id: string;
  to_id: string;
  from_name: string;
  to_name: string;
  from_port: string;
  to_port: string;
  role: string;
  speed: string;
  state: string;
  hall_id?: string | null;
}

export interface FabricPort {
  local_system: string;
  local_port: string;
  physical_port?: string;
  peer_system: string;
  peer_port: string;
  state: string;
  speed: string;
  cable_pn: string;
  role: string;
  hall_name?: string | null;
}

export interface ClusterMetrics {
  name: string;
  now: {
    cpu_pct: number;
    gpu_pct: number;
    mem_pct: number;
    power_kw: number;
    power_pct: number;
    tx_gbps: number;
    rx_gbps: number;
    disk_pct: number;
    disk_read_gbs?: number;
    disk_write_gbs?: number;
  };
  series: {
    t: number;
    cpu: number;
    gpu: number;
    mem: number;
    power_kw: number;
    tx_gbps: number;
    rx_gbps: number;
    disk_pct: number;
    disk_read_gbs: number;
    disk_write_gbs: number;
  }[];
  size: {
    halls: number;
    racks: number;
    gpus: number;
    nameplate_kw: number;
    cols: number;
    rows: number;
    racks_on?: number;
    compute_nodes?: number;
    compute_on?: number;
    spines?: number;
    leaves?: number;
    switches?: number;
    active_links?: number;
    active_ports?: number;
    total_ports?: number;
    speed?: string;
  };
  nodes: {
    total: number;
    active: number;
    ready: number;
    idle: number;
    off: number;
    compute_total?: number;
    compute_on?: number;
  };
  workload: {
    id: string;
    name: string;
    kind: string;
    status: string;
    gpu_allocation: number;
    pods_running: number;
    gpu_request?: number;
  } | null;
  workloads_running?: { name: string; kind: string; gpu_allocation: number }[];
  gpu_used: number;
  cpu_cores: number;
  mem_tb: number;
  disk_tb: number;
  disk_used_tb: number;
  range?: string;
  from_ts?: number;
  to_ts?: number;
}

export interface InventoryNode {
  id: string;
  kind: string;
  serial: string;
  name: string;
  hall_name: string | null;
  rack_id: string | null;
  bmc_mac: string | null;
  os_mac: string | null;
  pxe_mac: string | null;
  switch_mac: string | null;
  bmc_password: string | null;
  bmc_ip: string | null;
  os_ip: string | null;
  provision_status: string;
  sol_log: string | null;
  last_seen_at: string | null;
  provision_started_at: string | null;
}

export interface ProvisionSnapshot {
  nodes: InventoryNode[];
  dhcp: { ip: string; mac: string; hostname: string; lease: string; mapped: string; kind: string; iface: string }[];
  arp: { ip: string; mac: string; vendor: string; mapped: string; kind: string; state: string }[];
  summary: {
    nodes: number;
    compute: number;
    switches: number;
    mapped_macs: number;
    leases: number;
    status: Record<string, number>;
  };
}

export interface FabricSummary {
  spines: number;
  leaves: number;
  racks: number;
  total_ports: number;
  active_ports: number;
  speed: string;
}

export interface FabricTopology {
  nodes: FabricNode[];
  links: FabricLink[];
  summary: FabricSummary;
}

export interface LiveLink {
  id: string;
  from_id: string;
  to_id: string;
  from_name: string;
  to_name: string;
  role: string;
  tx_gbps: number;
  rx_gbps: number;
  util_pct: number;
  state: string;
}

export interface LiveTraffic {
  ts: number;
  active_links: number;
  total_tx_gbps: number;
  total_rx_gbps: number;
  nodes: Record<string, { tx_gbps: number; rx_gbps: number; util_pct: number }>;
  links: LiveLink[];
  all_links?: LiveLink[];
  summary?: FabricSummary;
}

export function formatGbps(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(2)} Tbps`;
  return `${v.toFixed(1)} Gbps`;
}
