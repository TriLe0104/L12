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

export function formatW(w: number): string {
  if (w >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}

export interface MaxLpsTopology {
  model: string;
  racks: number;
  nodes_per_rack: number;
  gpus_per_node: number;
  gpus_per_rack: number;
  gpu_tdp_w: number;
  gpu_idle_w: number;
  gpu_count: number;
  node_count: number;
}

export interface MaxLpsGpu {
  id: string;
  rank: number;
  rack_id: string;
  rack_label: string;
  hall_id: string;
  node: number;
  gpu: number;
  watts: number;
  setpoint_w: number;
  tdp_w: number;
  min_w: number;
  max_w?: number;
  curve?: number[];
  pct_limit: number;
  pct_tdp: number;
  hot: boolean;
  enabled: boolean;
}

export interface MaxLpsShelf {
  id: string;
  label: string;
  name: string;
  hall_id: string;
  power_state: string;
  enabled: boolean;
  denied: boolean;
  hot: boolean;
  extra: boolean;
  shelf_kw: number;
  gpu_kw: number;
  overhead_kw: number;
  allocated_kw: number;
  consumed_kw: number;
  setpoint_w: number;
  gpus_at_cap: number;
}

export interface MaxLpsView {
  topology: MaxLpsTopology;
  mode: string;
  tick: number;
  last_event: string;
  min_rack_kw: number;
  max_rack_kw: number;
  total_budget_kw?: number;
  envelope_kw?: number;
  threshold_pct?: number;
  racks_static_max?: number;
  racks_lps_max?: number;
  racks_lps_gain?: number;
  filter_rack_id?: string | null;
  totals: {
    shelf_kw: number;
    gpu_kw: number;
    overhead_kw?: number;
    hottest_w: number;
    avg_setpoint_w?: number;
    gpus_at_cap: number;
    gpus_listed: number;
    gpus_total: number;
    cap_kw?: number;
    allowable_kw?: number;
    best_cap_percent?: number;
  };
  algo?: {
    power_budget_w: number;
    budget_grace: number;
    gpu_power_percent: number;
    desired_cap_percent: number;
    max_allowable_w: number;
    best_cap_percent: number;
    n: number;
  };
  history?: { t: number; gpu_kw: number; overhead_kw: number; shelf_kw: number; cap_kw?: number; allowable_kw?: number }[];
  racks: MaxLpsShelf[];
  gpus: MaxLpsGpu[];
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

export type PowerAction = "reduce" | "increase" | "hold" | "enable" | "deny" | "off" | string;

export interface PowerRack {
  id: string;
  name: string;
  label: string;
  hall_id: string;
  power_state: string;
  run_status: string;
  demand_kw: number;
  consumed_kw: number;
  allocated_kw: number;
  unused_kw: number;
  nameplate_kw: number;
  min_kw?: number;
  max_kw?: number;
  usage_pct?: number;
  policy_kw?: number;
  enabled: boolean;
  denied: boolean;
  extra: boolean;
  hot?: boolean;
  at_cap?: boolean;
  action: PowerAction;
  gap_pct: number | null;
}

export interface PowerSummary {
  budget_kw: number;
  consumed_kw: number;
  allocated_kw: number;
  stranded_kw: number;
  headroom_kw: number;
  used_kw?: number;
  available_kw?: number;
  floating_kw?: number;
  placeable_kw?: number;
  surplus_kw?: number;
  racks_enabled: number;
  racks_denied: number;
  racks_extra: number;
  racks_off: number;
  racks_hot?: number;
  racks_at_cap?: number;
  actions: Record<string, number>;
}

export interface PowerShowcaseSlot {
  id: string;
  name: string;
  label: string;
  additional?: boolean;
  static: PowerRack;
  dynamic: PowerRack;
}

export interface PowerLimiter {
  mode: "static" | "dynamic" | string;
  budget_kw: number;
  auto_budget: boolean;
  nameplate_kw: number;
  tdp_kw: number;
  default_budget_kw?: number;
  max_budget_kw?: number;
  max_rack_kw?: number;
  min_rack_kw?: number;
  stay_under_pct?: number;
  threshold_pct?: number;
  total_budget_kw?: number;
  envelope_kw?: number;
  placeable_kw?: number;
  surplus_kw?: number;
  unplaced_budget_kw?: number;
  power_source?: string;
  halls?: number;
  rack_count?: number;
  rack_count_auto?: boolean;
  racks_on?: number;
  racks_pool?: number;
  racks_static_max?: number;
  racks_lps_max?: number;
  racks_lps_gain?: number;
  rack_avg_kw?: number;
  rack_policy_kw?: number;
  rack_share_kw?: number;
  rack_hard_kw?: number;
  policy: {
    reduce_gap_pct: number;
    increase_gap_pct: number;
    target_headroom_pct: number;
    enable_per_tick: number;
    default_mw?: number;
    max_mw?: number;
    min_rack_kw?: number;
    max_rack_kw?: number;
    stay_under_pct?: number;
    threshold_pct?: number;
    rack_avg_kw?: number;
    rack_count?: number;
    total_budget_kw?: number;
    envelope_kw?: number;
  };
  tick: number;
  last_event: string;
  static: PowerSummary;
  dynamic: PowerSummary;
  active: PowerSummary;
  showcase: PowerShowcaseSlot[];
  racks: PowerRack[];
  static_racks?: PowerRack[];
  dynamic_racks?: PowerRack[];
}
