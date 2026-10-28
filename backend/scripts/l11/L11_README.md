# Folder Structure Documentation

This document provides an overview of the folder structure and organization of the benchmarking and system validation scripts.

## Root Level

### AIO.sh

Main all-in-one script that likely orchestrates the execution of various benchmarks and tests.

---

## Main Directories

### benchmarks/

Contains numbered benchmark test suites (201-213), each focused on specific performance testing areas.

#### 201stress-ng/

System stress testing using stress-ng tool

- `01-run-stress-ng.sh` - Executes stress-ng benchmark
- `99-parse_stress-ng.sh` - Parses and processes stress-ng results

#### 202stressapptest/

Memory and system stress testing

- `01-run-stressapptest.sh` - Runs stressapptest benchmark
- `99-parse_stressapptest.sh` - Parses stressapptest output

#### 203stream/

Memory bandwidth benchmarking

- `99-parse_stream.sh` - Parses STREAM benchmark results
- `amd_zen_stream` - AMD Zen-specific STREAM binary/configuration

#### 204mprime/

CPU stress testing and validation using mprime/Prime95

- `01-run-mprime.sh` - Executes mprime benchmark
- `99-parse_mprime.sh` - Parses mprime results

#### 205fio/

Storage I/O performance testing using Flexible I/O (fio)

- `01-run-fio.sh` - Runs fio benchmark
- `99-parse_fio.sh` - Parses fio results

#### 206ib_write_bw/

InfiniBand write bandwidth testing

- `01-loopback-ib_write_bw.sh` - Loopback testing
- `02-2node-ib_write_bw.sh` - Two-node testing
- `03-2node-ib_write_bw_ib.sh` - Two-node IB-specific testing
- `99-parse_ib_write_bw.sh` - Parses InfiniBand results
- `dispatch/` - Job dispatch scripts
- `dispatch_ib/` - IB-specific dispatch scripts

#### 207rochpl/

ROCm HPL (High-Performance Linpack) testing for AMD GPUs

- `01-run_rochpl_single.sh` - Single-node execution
- `02-multi_rochpl_single_nic.sh` - Multi-instance, single NIC
- `02-multi_rochpl.sh` - Multi-node execution
- `99-parse_rochpl.sh` - Parses ROCm HPL results

#### 208nccl/

NVIDIA NCCL testing

- `01-run-nccl-single.sh` - Single-node NCCL testing
- `02-run-nccl-multi-node.sh` - Multi-node NCCL orchestrator with automatic passwordless SSH setup
- `99-parse_nccl.sh` - Parses NCCL results
- `dispatch/` - Job dispatch scripts for node execution

#### 209dcgm/

NVIDIA Data Center GPU Manager (DCGM) diagnostics

- `01-run-dcgm.sh` - Executes DCGM diagnostics
- `99-parse_dcgm.sh` - Parses DCGM results
- `SOP-DCGM_EUD_Installation.txt` - SOP for installing DCGM with EUD on target node for reference.

#### 210rccl/

AMD RCCL (ROCm Collective Communications Library) testing

- `01-rccl.sh` - Single-node RCCL testing
- `02-multi-node-rccl.sh` - Multi-node RCCL orchestrator with automatic passwordless SSH setup
- `99-parse_rccl.sh` - Parses RCCL results
- `dispatch/` - Job dispatch scripts for node execution

#### 211nv_stream/

NVIDIA GPU memory bandwidth benchmarking using STREAM

- `01-run-nv_stream.sh` - Executes NVIDIA STREAM benchmark (GPU memory bandwidth test)
- `99-parse_nv_stream.sh` - Parses NVIDIA STREAM results (dynamic columns: Copy/Scale/Add/Triad per GPU)

#### 212parallel-dcgm-stress/

Parallel execution of multiple benchmarks simultaneously

- `01-run-parallel-dcgm-stress.sh` - Runs DCGM and stress-ng in parallel
- `99-parse_parallel-dcgm-stress.sh` - Parses parallel test results; emits two CSV sections (DCGM + Stress-ng)

#### 213oneapi_stream/

Intel oneAPI STREAM memory bandwidth benchmarking

- `01-run-oneapi_stream.sh` - Executes oneAPI STREAM benchmark
- `99-parse_oneapi_stream.sh` - Parses oneAPI STREAM results (Threads, Array Size, Copy/Scale/Add/Triad MB/s)

---

### report/

Python module for generating L10 (single-node) and L11 (rack-level) PDF reports from the collected benchmark and sensor data. Has its own [report/README.md](report/README.md) with full usage details.

- `report_gen.py` - Entry point; `ReportGen` class + CLI. Auto-detects L10 vs L11 from the path structure
- `requirements.txt` - Python dependencies (`reportlab`, `Pillow`, `pandas`, `matplotlib`, `PyPDF2`)

**Usage:**

```bash
# Install dependencies (once)
pip install -r report/requirements.txt

# Generate L11 rack report
python report/report_gen.py --path racks/001

# Generate L10 single-node report
python report/report_gen.py --path racks/001/S1234567

# With watermark and sensor-group overrides
python report/report_gen.py --path racks/001 --watermark --fan-speeds true --gpu-temperatures false
```

Output PDFs are written to `racks/<rack_num>/report/`. AIO.sh option `4` runs this automatically using `report_venv/` for a managed Python environment.

---

### common/

Shared library scripts used across multiple benchmarks and utilities.

- `bench_params.sh` - Reads per-benchmark parameter overrides from `proj.json`'s `benchmark_params` section; provides `build_bench_params <bench_path> <proj_json>` which populates the `env_flags` array with `--script-env KEY=VAL` pairs for `rlog.sh`; sourced by `run_single_node_benchmarks.sh` and `run_paired_node_benchmarks.sh`
- `check_exit_code.sh` - Checks the exit code embedded in a `rlog.sh`-produced log file; returns `PASS` (exit 0) or `FAIL`
- `colors.sh` - Color code definitions (`GREEN`, `RED`, `YELLOW`, `RESET`, etc.) sourced by AIO.sh and most scripts
- `get_sys_hostname.sh` - Retrieves the hostname of a remote node over SSH
- `get_sys_serial.sh` - Retrieves the system serial number of a remote node over SSH
- `hostfile.sh` - Shared hostfile parsing library (source, do not execute); provides `node_in_filter`, `parse_hostfile_line`, and `resolve_rack_hostfile RACK_NUM` helpers; `resolve_rack_hostfile` finds the first `hostfile*.csv` under `racks/<RACK_NUM>/` relative to this script's own location; sourced by all orchestration scripts
- `load_config.sh` - Loads project configuration from `proj.json` using `jq`; exports `PROJ_NAME`, `PROJ_DISPLAY_NAME`, `IP_RANGE`, `ARP_IF`; requires `jq` (`sudo apt-get install jq`)
- `parse_common.sh` - Common parsing helpers: `find_latest_log`, `extract_common_metadata`, color codes, and width constants
- `run_remote.sh` - Remote execution utilities (supports password-based SSH via `PASS` environment variable)
- `scp_pass.sh` - Legacy SCP wrapper with password handling via `PASS` environment variable (mostly superseded by passwordless SSH)

---

### sanitycheck/

System validation and health check scripts. The main orchestrator has moved to `scripts/run_sanity_check.sh`.

#### 01-fw-sw_checks/

Firmware and software validation

- `01-firmwareinventoryinfo.sh` - Captures firmware inventory
- `02-software_capture.sh` - Captures software versions

#### 02-bom_checks/

Bill of Materials (BOM) validation

- `01-trilsanitychk.sh` - TRIL sanity checks, uses the new json format
- `02-parse_json.sh` - JSON parsing for BOM data
- `archive_bomchk_scripts/` - Archived BOM check scripts from past projects for reference

#### 03-health_checks/

Hardware health monitoring

- `01-psu_health.sh` - Power supply unit health checks
- `02-voltage_health.sh` - Voltage monitoring
- `03-sel_find_active_errors.sh` - System Event Log error detection

---

### scripts/

Orchestration and log management scripts.

- `parse_logs.sh` - Discovers all benchmark log directories under `racks/<rack_num>/` and invokes each benchmark's `99-parse_*.sh` parser; reads node order from `hostfile*.csv` (any matching filename); outputs a consolidated CSV to `racks/<rack_num>/summary_report/`
- `parse_sensor.sh` - Sensor data aggregation and violation checking; reads embedded `MIN_THRES`/`MAX_THRES` rows from each sensor CSV; outputs a PASS/FAIL-annotated min/max summary to `racks/<rack_num>/summary_report/`
- `run_sanity_check.sh` - Sanity check orchestrator: runs all 6 checks (FW, SW, BOM, PSU, Voltage, SEL) in parallel per node with a real-time status table; supports multi-node hostfile mode (`--nodes N1,N2,...` filter) and single-node mode; emits `##SC:` structured signals for web UI streaming; supports `--result-file PATH`
- `run_paired_node_benchmarks.sh` - Executes paired-node benchmarks: sets up passwordless SSH (host→nodes and node↔node), logs system info before/after, runs `PAIRED_BENCHMARKS`, then auto-invokes `parse_logs.sh` and `parse_sensor.sh`; supports `--result-file PATH`
- `run_single_node_benchmarks.sh` - Executes single-node benchmarks: sets up passwordless SSH (host→nodes), logs system info before/after, runs `BENCHMARKS` in parallel, then auto-invokes `parse_logs.sh` and `parse_sensor.sh`; emits `##BM:` structured signals for web UI streaming; supports `--result-file PATH`

---

### utils/

Miscellaneous utility scripts for system management and monitoring.

- `log_sys_info.sh` - Captures a remote system state snapshot (lspci, lshw, dmidecode, dmesg, ip a, ibstat, SEL) to `racks/<rack_num>/<SN>/101infosystem/`; called automatically before and after benchmarks by the orchestration scripts
- `rlog.sh` - Remote script runner with logging (`-p RACK_NUM` for auto log path under `racks/<rack_num>/`, `-f FILE` for explicit path)
- `arp-find.sh` - ARP-based device discovery
- `bios_update_hf.sh` - BIOS version check and update via Redfish; use `--hostfile PATH` or `--rack NNN` (resolves `hostfile*.csv` automatically); `--bios-ver VERSION` is required; omit `--bios-file` to run in check-only mode; add `--dry-run` to skip writes
- `check_sys_diff.sh` - Compares BEFORE/AFTER log pairs produced by `log_sys_info.sh`; checks `sel` and `dmidecode` files for changes; usage: `check_sys_diff.sh <folder>` (auto-discovers pairs) or `check_sys_diff.sh <before_file> <after_file>`; exits non-zero if differences are found

#### log_sys_info.sh

Captures a remote system state snapshot before and after benchmarks so changes can be detected.

**Usage:**

```bash
bash utils/log_sys_info.sh <log_path> <os_ip> <BEFORE|AFTER> [timestamp]
```

**What it collects:** `lspci -vvv`, `lshw`, `dmidecode`, `dmesg`, `ip a`, `ibstat`, `ipmitool sel list`

**Output location:** `racks/<rack_num>/<SN>/101infosystem/<script_name>_<timestamp>/<cmd>_<BEFORE|AFTER>.log`

Called automatically by `run_single_node_benchmarks.sh` and `run_paired_node_benchmarks.sh`. Use `check_sys_diff.sh` to compare the resulting BEFORE/AFTER log pairs.

- `archive_old_logs.sh` - Scans `racks/` and archives old timestamped run directories/files per node, keeping only the newest of each type; supports `--dry-run`
- `capture_golden.sh` - Standalone script to capture golden reference files (BOM, firmware, software) from a single node; writes `data/bom_golden.json`, golden FW/SW CSVs, and a capture log at `data/golden_capture.log`; invoked automatically by AIO.sh option `g` and by the web UI's sanity check golden capture action
- `cleanup_parallel.sh` - Parallel cleanup operations
- `ipfinder.sh` - BMC and OS IP discovery, validation, and remediation; specify nodes via `--rack NNN` (finds `hostfile*.csv` automatically) or `--hostfile PATH`; required: `--arp-interface IF`; optional: `--set-bmc-ip` to reconfigure mismatched BMC IPs via ipmitool, `--netmask X`, `--defgw IP`, `--ssh-user`/`--ssh-pass` for OS access; when an OS IP is mismatched it SSHes in and writes a static netplan config then applies it; discovers OS MAC via Redfish when not in the hostfile; checks and corrects hostnames via SSH
- `setup_ssh_host_to_nodes.sh` - Configure passwordless SSH from this host to target nodes
- `setup_ssh_node_to_node.sh` - Configure full-mesh passwordless SSH between target nodes
- `zip_subfolders.sh` - Archive subfolder utility

#### monitor/

Redfish BMC monitoring and sensor data validation scripts.

- `redfish_monitor_multi.sh` - Multi-node Redfish BMC monitoring; runs alongside a benchmark command and collects sensor data per node into timestamped CSV files
- `check_sensor_violations.sh` - Check sensor data CSV against a threshold file; exits `114514` if violations are detected
- `remove_abnormal_data.sh` - Scan a rack directory for sensor data files with threshold violations and remove them; supports `--dry-run`

#### capture_golden.sh

Captures golden reference files (BOM, firmware, software) from a single node for use as the comparison baseline in sanity checks.

**Usage:**

```bash
bash utils/capture_golden.sh <log_dir> <sys_sn> <os_ip> <bmc_ip> <bmc_pwd>
```

**What it captures:**

- **BOM golden** (`data/bom_golden.json`) — exports the node's hardware BOM via `01-trilsanitychk.sh`
- **Firmware golden** — FW inventory CSV written under `<log_dir>/<SN>/` via `01-firmwareinventoryinfo.sh`
- **Software golden** — SW version CSV written under `<log_dir>/<SN>/` via `02-software_capture.sh`

Full output is tee'd to `data/golden_capture.log`. AIO.sh option `g` and the web UI's **Sanity Check → Capture Golden** action both invoke this script.

---

#### setup_ssh_host_to_nodes.sh

Pushes the host's public key into each node's `authorized_keys` and populates the host's `known_hosts`. Use this to enable host → node passwordless SSH.

**Usage:**

```bash
# Basic usage (uses default password "test")
bash utils/setup_ssh_host_to_nodes.sh <ip1> <ip2> <ip3> ...

# With custom password and verification
PASS=<password> VERIFY=true bash utils/setup_ssh_host_to_nodes.sh <ip1> <ip2> <ip3> ...
```

#### setup_ssh_node_to_node.sh

Generates SSH key pairs on each node, exchanges all public keys into every node's `authorized_keys`, and populates each node's `known_hosts` for full mesh node ↔ node passwordless SSH.

**Usage:**

```bash
# Basic usage (uses default password "test", requires at least 2 nodes)
bash utils/setup_ssh_node_to_node.sh <ip1> <ip2> [ip3] ...

# With custom password, force key regeneration, and verification
PASS=<password> FORCE_REGEN=true VERIFY=true bash utils/setup_ssh_node_to_node.sh <ip1> <ip2> ...
```

**Note:** Multi-node orchestrators (NCCL/RCCL) automatically invoke both scripts. Run `setup_ssh_host_to_nodes.sh` alone for single-node workflows.

#### fw/

Firmware management utilities

- `flash_cx_nic_fw.sh` - ConnectX NIC firmware flashing

#### node/

Per-node maintenance and configuration scripts, run directly on individual nodes.

- `bring_up_interface.sh` - Bring up a network interface (optional remote execution via OS IP argument)
- `cleanup_node.sh` - Remove benchmark artifacts and reset node state
- `disable_acs.sh` - Disable PCIe ACS (Access Control Services) to allow direct GPU peer communication
- `eth2ib.sh` - Switch Mellanox/ConnectX NIC ports from Ethernet mode to InfiniBand mode
- `ib2eth.sh` - Switch Mellanox/ConnectX NIC ports from InfiniBand mode back to Ethernet mode
- `setup_root_login.sh` - Enable passwordless SSH and root login on a remote machine

---

## bench_info.json

Each benchmark directory contains a `bench_info.json` metadata file read by the orchestration scripts and the web UI:

```json
{
    "benchmark_title": ["Stress-ng"],
    "benchmark_paired_title": ["2-Node NCCL"]
}
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `benchmark_title` | Yes | Array of display labels for single-node benchmark scripts; joined with `" & "` when multiple values are present |
| `benchmark_paired_title` | No | Array of display labels for paired-node scripts; used when the benchmark has a multi-node variant |

The web UI uses these titles to group and label scripts in the Benchmarks tab. The orchestration scripts use `jq` to read `benchmark_title` for the `##BM:` status signals.

---

## SSE Signal Protocol

The orchestration scripts emit structured status signals to stdout that the web UI's streaming endpoints forward to the browser via Server-Sent Events (SSE). These signals are prefixed with `##` so they can be distinguished from normal log output.

### Benchmark signals (`run_single_node_benchmarks.sh`)

```text
##BM:<node>:<serial>:<bench_title>:<STATUS>:<timestamp_utc>:<log_path>
```

| Field | Example | Description |
| ----- | ------- | ----------- |
| `node` | `N1` | Node label from hostfile |
| `serial` | `S962013X5B17628` | System serial number |
| `bench_title` | `Stress-ng` | Display title from `bench_info.json` |
| `STATUS` | `RUNNING` / `DONE` / `FAIL` | Current state |
| `timestamp_utc` | `20260310T120000Z` | UTC ISO-8601 timestamp |
| `log_path` | `racks/001/.../log` | Absolute path to the log file |

### Sanity check signals (`run_sanity_check.sh`)

```text
##SC:<node>:<serial>:<check>:<STATUS>:<timestamp_utc>:<log_path>
```

| Field | Values | Description |
| ----- | ------ | ----------- |
| `check` | `fw` / `sw` / `bom` / `psu` / `voltage` / `sel` / `all` | Which check is being reported |
| `STATUS` | `RUNNING` / `PASS` / `FAIL` / `SKIPPED` | Current state |

All other fields are the same as the benchmark signal format.

---

## Naming Conventions

### Benchmark Scripts

- **01-*, 02-*, 03-***: Execution scripts (numbered by execution order or variant)
- **99-parse_***: Result parsing scripts (always numbered 99)

### Directory Organization

- **2XX/**: Benchmark test suites (200-series numbering)
- **0X-*/**: Sanity check categories (sequential ordering)

---

## Typical Workflow

### Recommended: Using AIO.sh Wrapper (Interactive)

The [AIO.sh](AIO.sh) wrapper provides an interactive menu-driven interface for the complete testing workflow.

#### 1. Initial Setup

Create project directory and navigate to it:

```bash
cd /mnt/share/your-project-name
```

Create hostfile at `racks/<RACK_NUM>/hostfile_r<RACK_NUM>.csv`:

```bash
mkdir -p racks/001
vi racks/001/hostfile_r001.csv
```

**Hostfile format:**

```csv
host_name_bmcmac,bmc_IP,OS_IP,eth0_os_ip_mac,bmc_pwd,Node XX,System_SN,bmc_mac,host_name_human,projname,rack_num
7C-C2-55-90-C2-94,192.168.9.1,192.168.9.2,905a089cd03c,TYMIUVAMEH,N1,S962013X5B17628,7cc25590c294,R001N1,B300JPCS,001
7C-C2-55-90-C2-9A,192.168.9.3,192.168.9.4,905a089cd048,TYOXNHXEAC,N2,S962013X5B17625,7cc25590c29a,R001N2,B300JPCS,001
```

Create project configuration file `proj.json`:

```bash
vi proj.json
```

**Configuration format:**

```json
{
  "project_name": "B300",
  "proj_display_name": "B300 Acceptance Test",
  "ip_range": "192.168.8.1-192.168.15.255",
  "arp_interface": "eno2"
}
```

| Field | Description |
| ----- | ----------- |
| `project_name` | Short project identifier used in log paths and reports |
| `proj_display_name` | Human-readable project name shown in reports |
| `ip_range` | IP range for ARP-based node discovery |
| `arp_interface` | Network interface used for PXE/ARP discovery |

> **Note:** `load_config.sh` requires `jq` to parse the JSON file. Install with `sudo apt-get install jq`.

#### 2. Configure Tests

Edit [scripts/run_single_node_benchmarks.sh](scripts/run_single_node_benchmarks.sh) to uncomment desired tests:

```bash
vi scripts/run_single_node_benchmarks.sh
```

```bash
BENCHMARKS=(
    "$SCRIPT_DIR/../benchmarks/201stress-ng/01-run-stress-ng.sh"
    "$SCRIPT_DIR/../benchmarks/204mprime/01-run-mprime.sh"
    "$SCRIPT_DIR/../benchmarks/209dcgm/01-run-dcgm.sh"
)
```

Edit [scripts/run_paired_node_benchmarks.sh](scripts/run_paired_node_benchmarks.sh) for multi-node tests:

```bash
vi scripts/run_paired_node_benchmarks.sh
```

```bash
PAIRED_BENCHMARKS=(
    "$SCRIPT_DIR/../benchmarks/206ib_write_bw/03-2node-ib_write_bw_ib.sh"
    "$SCRIPT_DIR/../benchmarks/208nccl/02-run-nccl-multi-node.sh"
    "$SCRIPT_DIR/../benchmarks/210rccl/02-multi-node-rccl.sh"
)
```

**Note:** Multi-node orchestrators (NCCL/RCCL) automatically configure passwordless SSH if not already set up. The `PASS` environment variable is optional - only needed if passwordless SSH needs to be established.

#### 3. Run AIO.sh Wrapper

```bash
bash AIO.sh
```

Enter the rack number when prompted (e.g., `1` for R001).

#### 4. Interactive Menu Workflow

The wrapper provides a checklist-based interface:

```text
==== Rack R001 Checklist ====
1) Check Node Status [ ]
2) Run Sanity Check [ ]
3) Run All Benchmarks [ ]
4) Generate Report [ ]
5) Cleanup [ ]
======== Tool scripts ========
g) Capture Golden FW&BOM [ ]
s) Run Single Node Benchmarks
p) Run Paired Node Benchmarks
l) Parse Benchmark Logs
d) Parse Sensor Data
c) Remove Abnormal Sensor Data
0) Exit
```

**Step-by-step execution:**

##### a) Check Node Status (Option 1)

```text
Choose an option: 1
```

- Verifies BMC and OS IP connectivity
- Validates against hostfile entries
- Marks complete: `1) Check Node Status [✔]`

##### b) Capture Golden FW/BOM (Option g)

```text
Choose an option: g
```

- Captures reference firmware and BOM from Node 1 (default)
- Specify different node: `g:3` (captures from Node 3)
- Output saved to `data/` (`bom_golden.json`, `fw_golden.csv`, `sw_golden.csv`)
- **Action Required:** Manually verify against expected BOM
- Marks complete: `g) Capture Golden FW&BOM [✔]`

##### c) Run Sanity Check (Option 2)

```text
Choose an option: 2
```

- Runs all checks from `sanitycheck/` directory:
  - Firmware validation
  - Software validation
  - BOM comparison
  - PSU health
  - Voltage health
  - SEL (System Event Log) errors
- Displays results table with PASS/FAIL per node
- Marks complete: `2) Run Sanity Check [✔]`

##### d) Run All Benchmarks (Option 3)

```text
Choose an option: 3
```

- Executes all enabled single-node benchmarks
- Executes all enabled paired-node benchmarks
- Progress tracked per node
- Failed nodes marked: `3) Run All Benchmarks [⚠ !3,4]`

**Rerun failed nodes:**

```text
Choose an option: 3:3,4
```

- Marks complete when all pass: `3) Run All Benchmarks [✔]`

##### e) Generate Report (Option 4)

```text
Choose an option: 4
```

- Runs all `99-parse_*.sh` scripts
- Generates consolidated CSV report
- Marks complete: `4) Generate Report [✔]`

##### f) Cleanup (Option 5)

```text
Choose an option: 5
```

- **WARNING: Destructive operation!**
- Formats all NVMe disks (data loss)
- Resets BMC IP to DHCP
- Powers off systems
- Clears SEL logs
- Requires confirmation before proceeding
- Marks complete: `5) Cleanup [✔]`

#### 5. Command Syntax

All options support node-specific execution:

```text
<option>[:comma_separated_list_of_nodes]
```

**Examples:**

- `2` - Sanity check all nodes
- `2:1,2,3` - Sanity check nodes 1, 2, 3 only
- `s:1,3` - Run single-node benchmarks on nodes 1 and 3
- `p:1,4` - Run paired benchmarks using nodes 1 and 4
- `g:2` - Capture golden FW/BOM from node 2

---

### Alternative: Manual Execution (Advanced)

For direct script execution without the wrapper:

#### 1. System Preparation

- Run sanity checks from `sanitycheck/`
- Verify system health using `sanitycheck/03-health_checks/`
- Set up host → node SSH: `PASS=<password> bash utils/setup_ssh_host_to_nodes.sh <ip1> <ip2> <ip3> ...`
- Set up node ↔ node SSH: `PASS=<password> bash utils/setup_ssh_node_to_node.sh <ip1> <ip2> <ip3> ...`
- Note: Multi-node orchestrators (NCCL/RCCL) automatically invoke both scripts if needed

#### 2. Benchmark Execution

- Use `scripts/run_single_node_benchmarks.sh` for standalone testing
- Use `scripts/run_paired_node_benchmarks.sh` for distributed testing
- Individual benchmarks can be run from their respective `benchmarks/2XX/` directories

#### 3. Result Processing

- Each benchmark directory contains a `99-parse_*.sh` script
- Use `scripts/parse_logs.sh` for centralized log parsing. Specify one or more rack numbers to parse only those racks (e.g., `bash scripts/parse_logs.sh 001 002`). If not supplied, all entries under `racks/` are parsed. Node ordering follows the hostfile when available
- Use `scripts/parse_sensor.sh` for sensor data aggregation and threshold violation checking. Run after benchmarks complete to generate timestamped min/max summaries

#### 4. Monitoring & Utilities

- Monitor system health with [utils/monitor/redfish_monitor_multi.sh](utils/monitor/redfish_monitor_multi.sh)
- Check sensor data for violations with [utils/monitor/check_sensor_violations.sh](utils/monitor/check_sensor_violations.sh)

---

## Dependencies

Most scripts rely on:

- Shared libraries in `common/` directory
- `proj.json` configuration file (loaded via `common/load_config.sh`); requires `jq` (`sudo apt-get install jq`)
- SSH connectivity for remote operations
- `sshpass` for initial passwordless SSH setup (if nodes require password authentication)
- Various benchmark tools (stress-ng, fio, NCCL, RCCL, etc.)
- `ipmitool` for BMC/SEL operations (used by `log_sys_info.sh` and health checks)

---

## Sensor Data Analysis

### parse_sensor.sh

Collects and analyzes sensor data from all nodes, generating min/max summaries and checking for threshold violations.

#### What It Does

1. **Data Collection**: Discovers all sensor data files (`103sensor/redfish_data_*.csv`) from each node
2. **Aggregation**: Calculates minimum and maximum values for each sensor across all timestamped measurements
3. **Output Generation**: Creates a timestamped CSV with min/max values per node in format:

   ```text
   sensor_min_max_summary_<timestamp>.csv
   ```

4. **Violation Detection**: Checks sensor values against thresholds defined in `redfish_thresholds.csv` and reports violations

#### Usage

```bash
# Parse sensor data for all racks
bash scripts/parse_sensor.sh

# Parse sensor data for a specific rack
bash scripts/parse_sensor.sh 001

# Parse multiple racks
bash scripts/parse_sensor.sh 001 002 003
```

#### Output Format

The generated CSV contains:

- **Rows**: Each sensor name (CPU Temp, GPU Temp, Voltages, Power, etc.)
- **Columns**: For each node: `<NODE_SN>_min` and `<NODE_SN>_max`

Example:

```csv
Sensor,S962013X6110251_min,S962013X6110251_max,S962013X6110252_min,S962013X6110252_max
CPU1 Temp (°C),50,64,52,66
CPU2 Temp (°C),47,59,49,65
HGX GPU Temp (°C),36,68,36,69
```

#### Violation Checking

The script automatically checks each node's sensor data against threshold files:

- **Threshold file**: `racks/<rack_num>/<NODE_SN>/103sensor/redfish_thresholds.csv`
- **Exit codes**:
  - `0` = No violations
  - `114514` = Violations detected
  - `1` = Error

**Sample Output:**

```text
✓ No violations - Node: S962013X6110251, File: redfish_data_20260204_011252.csv
✗ VIOLATIONS DETECTED - Node: S962013X6110252, File: redfish_data_20260204_011254.csv
  • CPU1 Temp (°C): MAX = 108.00 (threshold MAX 106.00)
  • HGX GPU Temp (°C): MAX = 92.00 (threshold MAX 89.00)
```

#### Output Location

Files are saved to: `racks/<rack_num>/summary_report/sensor_min_max_summary_<timestamp>.csv`

#### Integration

Run after benchmarks complete, typically after `parse_logs.sh`:

```bash
# Complete workflow
# Note: parse_logs.sh and parse_sensor.sh are called automatically at the end
bash scripts/run_single_node_benchmarks.sh 001 racks/001/hostfile_r001.csv
# Or run on specific nodes only:
bash scripts/run_single_node_benchmarks.sh 001 racks/001/hostfile_r001.csv 1,2,3
# To re-parse manually:
bash scripts/parse_logs.sh 001
bash scripts/parse_sensor.sh 001
```

---

## Adding New Benchmark Tests

This section provides step-by-step instructions for adding new benchmark tests to the framework.

### Overview

Each benchmark requires:

- A numbered directory under `benchmarks/` (e.g., `213newbenchmark/`)
- One or more execution scripts (`01-*.sh`, `02-*.sh`, etc.)
- A mandatory parse script (`99-parse_*.sh`)
- Integration with orchestration scripts (`run_single_node_benchmarks.sh` or `run_paired_node_benchmarks.sh`)

---

### Requirements Summary

#### Directory Structure Requirements

```text
benchmarks/2XXnewbenchmark/
├── 01-run-newbenchmark.sh        # Execution script(s)
├── 99-parse_newbenchmark.sh      # Required: parse script
└── dispatch/                      # Optional: client/server scripts
    ├── client.sh
    └── server.sh
```

**Naming Conventions:**

- Use sequential numbering (213, 214, etc.)
- Lowercase, descriptive names without spaces
- Prefix: `01-`, `02-`, `03-` for execution scripts
- Parse scripts always numbered `99-parse_*.sh`

#### Execution Script Requirements

**Single-Node Scripts:**

These are simple scripts that perform the actual benchmark test. The `run_single_node_benchmarks.sh` framework handles all logging automatically through the `utils/rlog.sh` wrapper.

**How It's Called:**
The orchestration script calls your benchmark through the `utils/rlog.sh` wrapper:

```bash
bash "$LOG_SCRIPT" -p "$RACK_NUM" "$OS_IP" "$bench"
```

The `rlog.sh` wrapper automatically:

- Uploads the script to the remote host if not already present
- Creates timestamped log files under `racks/<rack_num>/<serial_number>/<benchmark_name>/`
- Captures all stdout and stderr output
- Records start/end times with system info header/footer
- Logs system information (hostname, SN, kernel, OS version)
- Preserves exit codes

**Paired-Node Scripts:**

For multi-node benchmarks, you handle coordination between nodes. Use `utils/rlog.sh` with `-f` for explicit log file placement.

- **Arguments:** `<log_path>` `<node1_ip>` `<node2_ip>`
- **Responsibilities:**
  - Coordinate server/client roles between nodes
  - Use `run_remote` from `common/` or `utils/rlog.sh` for remote execution
  - Handle cleanup of both nodes
  - Create log directory structure manually for multi-node tests
  - Optional: Set up passwordless SSH automatically (see NCCL/RCCL orchestrators for reference)

**Node-Specific Scripts (Absolute Path Pattern):**

When each node needs a unique version of a script (e.g. different IPs, roles, or parameters baked in), create the script at the **same absolute path on each node**. `rlog.sh` detects the script already exists on the remote and skips upload — so each node runs its own pre-installed version:

```bash
# Write a node-specific script directly onto each remote node at a fixed path
ssh root@$NODE1_IP 'cat > /tmp/run_test.sh' <<EOF
#!/bin/bash
benchmark_tool --role server --bind $NODE1_IP
EOF

ssh root@$NODE2_IP 'cat > /tmp/run_test.sh' <<EOF
#!/bin/bash
benchmark_tool --role client --server $NODE1_IP
EOF

# rlog.sh finds /tmp/run_test.sh on each remote and does NOT re-upload
bash "$RLOG" -f "$LOG_DIR/node1.log" "$NODE1_IP" "/tmp/run_test.sh" &
bash "$RLOG" -f "$LOG_DIR/node2.log" "$NODE2_IP" "/tmp/run_test.sh" &
wait
```

For scripts that are **identical across nodes**, just use a relative or local absolute path — `rlog.sh` will upload it automatically.

```bash
#!/bin/bash
# 02-run-multi-node-newbenchmark.sh
# Usage: 02-run-multi-node-newbenchmark.sh <log_path> <server_ip> <client_ip>

LOG_PATH=$1
SERVER_IP=$2
CLIENT_IP=$3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RLOG="$SCRIPT_DIR/../../utils/rlog.sh"
TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"

# Create log directory
LOG_DIR="$LOG_PATH/${SERVER_IP}_${CLIENT_IP}/${TIMESTAMP}_newbenchmark"
mkdir -p "$LOG_DIR"

# Write node-specific scripts onto each node at the same absolute path
ssh -o StrictHostKeyChecking=no root@$SERVER_IP 'cat > /tmp/run_newbenchmark.sh && chmod +x /tmp/run_newbenchmark.sh' <<EOF
#!/bin/bash
benchmark_server_command
EOF

ssh -o StrictHostKeyChecking=no root@$CLIENT_IP 'cat > /tmp/run_newbenchmark.sh && chmod +x /tmp/run_newbenchmark.sh' <<EOF
#!/bin/bash
benchmark_client_command --server $SERVER_IP
EOF

# rlog.sh finds the script already on each remote — no upload
bash "$RLOG" -f "$LOG_DIR/server.log" "$SERVER_IP" "/tmp/run_newbenchmark.sh" &
bash "$RLOG" -f "$LOG_DIR/client.log" "$CLIENT_IP" "/tmp/run_newbenchmark.sh" &
wait
echo "Test completed."
```

#### Parse Script Requirements (99-parse_*.sh)

**Mandatory Structure:**

- **Arguments:** `[hostname@]<benchmark_dir1> [[hostname@]<benchmark_dir2> ...]`
  - Each positional argument is the **direct path** to one node's benchmark log directory (e.g. `racks/001/SN001/201stress-ng/`)
  - The optional `hostname@` prefix provides a human-readable node label shown in console output; the path after `@` is used for file access
- **Must source:** `common/parse_common.sh`, `common/check_exit_code.sh`
- **Output format:** Section title + CSV header + CSV rows (stdout); colored status per node (stderr)
- **Standard CSV columns:** `Node,SN,Result,Time Started,Time Completed,Duration` + benchmark-specific columns
- **Result values:** `PASS` or `FAIL`
- **`sys_sn`** is derived from `basename "$(dirname "$benchmark_dir")"` — the parent directory is the node's serial number folder

**Expected Behavior:**

- Iterate over all `"$@"` arguments
- Strip `hostname@` prefix if present; use hostname as display label, remainder as directory path
- Call `find_latest_log` on the benchmark directory to locate the most recent log file
- Call `extract_common_metadata` to populate `time_start`, `time_end`, `duration`
- Parse benchmark-specific metrics from the log
- Emit one CSV row per node to stdout
- Emit colored `[hostname | SN - Benchmark]  PASS/FAIL | details` line to stderr
- Wrap all rows in a subshell; print section title + CSV header + rows only if any rows were produced

**Caller convention (parse_logs.sh):**

```bash
bash "$parser_script" "${node_hostname}@${benchmark_log_dir}" ...
```

The `scripts/parse_logs.sh` orchestrator discovers the latest benchmark log directory for each node and passes `hostname@path` arguments automatically.

#### Integration Requirements

**For run_single_node_benchmarks.sh:**

- Add script path to `BENCHMARKS` array
- The script is uploaded to the remote node and executed via `utils/rlog.sh`
- Framework handles: passwordless SSH setup, parallel execution, system info capture (BEFORE/AFTER), logging directories, status tracking, and automatic log/sensor parsing after all nodes complete

**For run_paired_node_benchmarks.sh:**

- Add script path to `PAIRED_BENCHMARKS` array
- Script receives: `<log_path>` `<node1_ip>` `<node2_ip>`
- Framework handles: passwordless SSH setup (host→nodes and node↔node), node pairing, parallel pair execution, system info capture (BEFORE/AFTER), and automatic log/sensor parsing after all pairs complete

---

### Parse Script CSV Output Reference

All parse scripts share the standard output header followed by benchmark-specific columns.

**Standard columns (all benchmarks):** `Node, SN, Result, Time Started, Time Completed, Duration`

| Benchmark | Title | Additional CSV Columns |
| --------- | ----- | ---------------------- |
| 201 stress-ng | `Stress-ng` | `Skipped, Passed, Failed` |
| 202 stressapptest | `Stressapptest` | *(none)* |
| 203 stream | `STREAM` | `Triad MB/s` |
| 204 mprime | `MPRIME` | `Tests, Error, Warning` |
| 205 fio | `FIO` | `IOPS, BW, Latency` |
| 206 ib_write_bw | `ib_write_bw` | Dynamic per discovered NIC: `<iface> Avg BW(GB/s), <iface> Peak BW(GB/s)` |
| 207 rochpl | `rochpl` | `Total Iterations, Successful Iterations, Residual Check Passed, Avg TFLOPS, Peak TFLOPS` |
| 208 nccl | `nccl` | `Num Nodes, Peer SNs, All Reduce(out-of-place)GB/s, All Reduce(in-place)GB/s, All Gather(out-of-place)GB/s, All Gather(in-place)GB/s, All To All(out-of-place)GB/s, All To All(in-place)GB/s` |
| 209 dcgm | `DCGM` | `Total Tests, Tests Passed, Tests Failed, EUD` |
| 210 rccl | `RCCL` | `All Reduce(out-of-place)GB/s, All Reduce(in-place)GB/s, All Gather(out-of-place)GB/s, All Gather(in-place)GB/s, All To All(out-of-place)GB/s, All To All(in-place)GB/s` |
| 211 nv_stream | `NVIDIA STREAM` | Dynamic per GPU: `GPU<N> Copy MB/s, GPU<N> Scale MB/s, GPU<N> Add MB/s, GPU<N> Triad MB/s` |
| 212 parallel-dcgm-stress | *(two sections)* | Emits a **DCGM** section (same as 209) followed by a **Stress-ng** section (same as 201) |
| 213 oneapi_stream | `oneAPI STREAM` | `Threads, Array Size, Total Mem (MiB), Copy MB/s, Scale MB/s, Add MB/s, Triad MB/s` |

---

### Implementation Steps

#### Step 1: Create Benchmark Directory

Use the next available number in the 2XX series:

```bash
mkdir -p benchmarks/213newbenchmark
cd benchmarks/213newbenchmark
```

#### Step 2: Create Execution Script

**Example: `01-run-newbenchmark.sh`**

```bash
#!/bin/bash
# 01-run-newbenchmark.sh - New benchmark execution script
# Usage: 01-run-newbenchmark.sh [duration_minutes]
# Note: Logging is handled automatically by the utils/rlog.sh wrapper

# Parse arguments
DURATION_MINUTES="${1:-10}"

# Ensure benchmark tool is installed
if ! command -v your_benchmark_tool &> /dev/null; then
    echo "Installing your_benchmark_tool..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq your_benchmark_tool
fi

# Run the benchmark
echo "Running new benchmark for $DURATION_MINUTES minutes..."
your_benchmark_tool --duration "$DURATION_MINUTES" --options
```

**That's it!** The `utils/rlog.sh` wrapper called by `run_single_node_benchmarks.sh` will:

- Upload this script to the remote host
- Create the log file
- Capture all output from your script
- Add timestamps and system information
- Handle exit codes

**For reference - see actual examples:**

- Simple: [benchmarks/201stress-ng/01-run-stress-ng.sh](benchmarks/201stress-ng/01-run-stress-ng.sh)
- With setup: [benchmarks/204mprime/01-run-mprime.sh](benchmarks/204mprime/01-run-mprime.sh)

#### Step 3: Create Parse Script

Parse scripts receive a list of benchmark log directories — one per node — directly as positional arguments. They output a CSV section (title + header + rows) to stdout and colored per-node status lines to stderr.

**Key Variable to Define:**

```bash
BENCHMARK_TITLE="New Benchmark"    # Display name used as CSV section header
```

**Standard Structure:**

```bash
#!/bin/bash
# 99-parse_newbenchmark.sh
# Usage: 99-parse_newbenchmark.sh [hostname@]<benchmark_dir1> [[hostname@]<benchmark_dir2> ...]
#   Each argument is the direct path to a node's benchmark log directory.
#   Optional 'hostname@' prefix provides a human-readable label for console output.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$PROJECT_ROOT/common/parse_common.sh"
source "$PROJECT_ROOT/common/check_exit_code.sh"

BENCHMARK_TITLE="New Benchmark"

rows=$(for benchmark_dir in "$@"; do
    # Strip optional hostname prefix
    if [[ "$benchmark_dir" == *@* ]]; then
        hostname="${benchmark_dir%%@*}"
        benchmark_dir="${benchmark_dir#*@}"
    else
        hostname="N/A"
    fi

    [[ -d "$benchmark_dir" ]] || continue

    # Find latest log
    latest_log=$(find_latest_log "$benchmark_dir" ".*" "^script")
    [[ -z "$latest_log" || ! -f "$latest_log" ]] && continue

    # sys_sn = parent directory name (node serial number folder)
    sys_sn=$(basename "$(dirname "$benchmark_dir")")
    extract_common_metadata "$latest_log"

    # ===== CUSTOMIZE THIS SECTION =====
    # Parse YOUR benchmark-specific metrics from the log file
    metric1=$(grep "YourMetric1:" "$latest_log" | awk '{print $2}')
    metric2=$(grep "YourMetric2:" "$latest_log" | awk '{print $2}')
    metric3=$(grep "YourMetric3:" "$latest_log" | awk '{print $2}')

    metric1=${metric1:-N/A}
    metric2=${metric2:-N/A}
    metric3=${metric3:-N/A}

    # Determine benchmark-specific pass/fail
    bench_status="PASS"  # or derive from metrics
    # ==================================

    # Check exit code (overrides bench_status if non-zero)
    status=$(check_exit_code "$latest_log" "$bench_status")

    # Console output to stderr (colored)
    cstatus=$([ "$status" == "PASS" ] && echo -e "${GREEN}PASS${NC}" || echo -e "${RED}FAIL${NC}")
    printf "[ %-*s | %-*s ]  %-*b | %s\n" \
        "$RACK_WIDTH" "$hostname" "$NODE_BENCH_WIDTH" "$sys_sn - $BENCHMARK_TITLE" \
        "$STATUS_WIDTH" "$cstatus" "$metric1" >&2

    # CSV row to stdout
    echo "$hostname,$sys_sn,$status,$time_start,$time_end,$duration,$metric1,$metric2,$metric3"
done)

if [[ -n "$rows" ]]; then
    echo ""
    echo "${BENCHMARK_TITLE}"
    echo "Node,SN,Result,Time Started,Time Completed,Duration,Metric1,Metric2,Metric3"
    echo "$rows"
fi
```

**Helper Functions Available:**

From `common/parse_common.sh`:

- `find_latest_log <dir> <pattern> [exclude]` - Finds most recent log file
- `extract_common_metadata <log_file>` - Sets `time_start`, `time_end`, `duration` variables
- Color codes: `$GREEN`, `$RED`, `$NC`, `$YELLOW`
- Width constants: `$RACK_WIDTH`, `$NODE_BENCH_WIDTH`, `$STATUS_WIDTH`

From `common/check_exit_code.sh`:

- `check_exit_code <log_file> [default_status]` - Returns "PASS" or "FAIL" based on exit code

**What You Need to Customize:**

1. `BENCHMARK_TITLE` - Display name (used as the CSV section header)
2. CSV header columns (after the standard six columns)
3. Metric parsing logic (`grep`/`awk`/`sed` from `$latest_log`)
4. Optional: benchmark-specific pass/fail logic (default falls back to exit code check)

**For reference - see actual example:**

- [benchmarks/201stress-ng/99-parse_stress-ng.sh](benchmarks/201stress-ng/99-parse_stress-ng.sh)

#### Step 4: Make Scripts Executable

```bash
chmod +x benchmarks/213newbenchmark/*.sh
```

#### Step 5: Integrate with Orchestration Scripts

**For Single-Node Benchmarks:**

Edit [scripts/run_single_node_benchmarks.sh](scripts/run_single_node_benchmarks.sh) and add to the `BENCHMARKS` array:

```bash
BENCHMARKS=(
    # ... existing benchmarks ...
    "$SCRIPT_DIR/../benchmarks/213newbenchmark/01-run-newbenchmark.sh"
)
```

**For Paired-Node Benchmarks:**

Edit [scripts/run_paired_node_benchmarks.sh](scripts/run_paired_node_benchmarks.sh) and add to the `PAIRED_BENCHMARKS` array:

```bash
PAIRED_BENCHMARKS=(
    # ... existing benchmarks ...
    "$SCRIPT_DIR/../benchmarks/213newbenchmark/02-run-multi-node-newbenchmark.sh"
)
```

**Example Paired Script:**

```bash
#!/bin/bash
# 02-run-multi-node-newbenchmark.sh
# Usage: 02-run-multi-node-newbenchmark.sh <log_path> <server_ip> <client_ip>

set -euo pipefail

LOG_PATH="$1"
SERVER_IP="$2"
CLIENT_IP="$3"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../common/run_remote.sh"

RLOG="$SCRIPT_DIR/../../utils/rlog.sh"
TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
LOG_DIR="$LOG_PATH/${SERVER_IP}_${CLIENT_IP}/${TIMESTAMP}_newbenchmark"
mkdir -p "$LOG_DIR"

# Write node-specific scripts at the same absolute path on each node.
# rlog.sh will detect the script already exists on the remote and skip upload,
# so each node runs its own pre-installed version.
ssh -o StrictHostKeyChecking=no root@$SERVER_IP 'cat > /tmp/run_newbenchmark.sh && chmod +x /tmp/run_newbenchmark.sh' <<EOF
#!/bin/bash
benchmark_server_command
EOF

ssh -o StrictHostKeyChecking=no root@$CLIENT_IP 'cat > /tmp/run_newbenchmark.sh && chmod +x /tmp/run_newbenchmark.sh' <<EOF
#!/bin/bash
benchmark_client_command --server $SERVER_IP
EOF

# Run both nodes in parallel; rlog.sh finds the script on each remote, no upload needed
bash "$RLOG" -f "$LOG_DIR/server.log" "$SERVER_IP" "/tmp/run_newbenchmark.sh" &
bash "$RLOG" -f "$LOG_DIR/client.log" "$CLIENT_IP" "/tmp/run_newbenchmark.sh" &
wait
echo "Multi-node test completed."
```

**For reference - see actual example:**

- [benchmarks/206ib_write_bw/03-2node-ib_write_bw_ib.sh](benchmarks/206ib_write_bw/03-2node-ib_write_bw_ib.sh)

#### Step 6: Test Your Benchmark

**Test Individual Components:**

```bash
# Test execution script directly
cd benchmarks/213newbenchmark
./01-run-newbenchmark.sh 5

# Verify log files were created
ls -la ../../racks/001/SN001/213newbenchmark/

# Test parse script by passing a benchmark log directory directly
./99-parse_newbenchmark.sh R001N1@../../racks/001/SN001/213newbenchmark/
```

**Test Integration:**

```bash
# Test with run_single_node_benchmarks.sh
cd scripts
./run_single_node_benchmarks.sh 001 ../racks/001/hostfile_r001.csv

# Test parsing all results
./parse_logs.sh 001

# Test sensor data parsing and violation checking
./parse_sensor.sh 001

# Test paired benchmark (if applicable)
./run_paired_node_benchmarks.sh 001 ../racks/001/hostfile_r001.csv 1,2
```

#### Adding dispatch/ Directory

To make scripts run faster you may dispatch them to the node. Here the dispatched scripts are in the dispatch folder but it is not a requirement. You may use any arbitrary name

```text
benchmarks/213newbenchmark/
├── 01-run-newbenchmark.sh
├── 02-multi-node-newbenchmark.sh
├── 99-parse_newbenchmark.sh
└── dispatch/
    ├── client.sh
    └── server.sh
```

Dispatch scripts handle the client/server coordination separately from the main execution script.
