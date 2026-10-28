#!/usr/bin/env bash
set -euo pipefail

# One-host RoCEv2 ib_write_bw loopback harness using Linux netns.
# This script uses a hard-coded PAIRS array to force tests onto specific RDMA hardware.

# --- Tunables (override via env) ---
# DURATION and RUN_NUM are now handled by command-line arguments in main()
EXCHANGES="${EXCHANGES:-0}"      # 0 means duration-mode; set >0 for iteration-mode
QPS="${QPS:-2}"                  # Number of queue pairs per connection
MSG="${MSG:-65536}"              # Message size in bytes
PL="${PL:-32}"                   # Post list size
MTU="${MTU:-9000}"               # L2 MTU to set on each port
BASE_PORT="${BASE_PORT:-48281}"  # TCP/UDP base port for ib_write_bw
ROCE_FLAG="-R"                   # Use RoCEv2

# --- Define Interface Pairs with their corresponding RDMA devices ---
# Each line: <left_iface> <right_iface> <left_ip> <right_ip> <port> <left_rdma_dev> <right_rdma_dev>
PAIRS=(
  "enp9s0         enp25s0         192.168.100.100 192.168.100.101 $((BASE_PORT+0)) rocep9s0         rocep25s0"
  "enp121s0       enp105s0        192.168.100.102 192.168.100.103 $((BASE_PORT+1)) rocep121s0       rocep105s0"
  "enp137s0       enp153s0        192.168.100.104 192.168.100.105 $((BASE_PORT+2)) rocep137s0       rocep153s0"
  "enp249s0       enp233s0        192.168.100.106 192.168.100.107 $((BASE_PORT+3)) rocep249s0       rocep233s0"
  "enp193s0f0np0  enp193s0f1np1  192.168.100.108 192.168.100.109 $((BASE_PORT+4)) rocep193s0f0     rocep193s0f1"
)

# --- Define Physical Interface Location Index ---
declare -A LOCATIONS=(
    [enp9s0]="L1"
    [enp25s0]="L2"
    [enp121s0]="L3"
    [enp105s0]="L4"
    [enp137s0]="L5"
    [enp153s0]="L6"
    [enp249s0]="L7"
    [enp233s0]="L8"
    [enp193s0f0np0]="F1"
    [enp193s0f1np1]="F2"
)

# Array to hold only pairs that pass the connectivity check.
declare -a WORKING_PAIRS=()


# --- Core Functions ---

ns_name() { echo "ns_$1"; }

need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Error: Please run this script as root (sudo)." >&2
    exit 1
  fi
}

check_tools() {
  for t in ip ethtool ib_write_bw gawk; do
    command -v "$t" >/dev/null 2>&1 || { echo "Missing required tool: $t"; exit 1; }
  done
}

setup_pair() {
  local IF_A="$1" IF_B="$2" IP_A="$3" IP_B="$4"
  local NS_A=$(ns_name "$IF_A")
  local NS_B=$(ns_name "$IF_B")

  ip netns add "$NS_A" 2>/dev/null || true
  ip netns add "$NS_B" 2>/dev/null || true

  ip link set "$IF_A" netns "$NS_A"
  ip link set "$IF_B" netns "$NS_B"

  ip -n "$NS_A" addr add "$IP_A/31" dev "$IF_A"
  ip -n "$NS_B" addr add "$IP_B/31" dev "$IF_B"

  ip -n "$NS_A" link set "$IF_A" up mtu "$MTU"
  ip -n "$NS_B" link set "$IF_B" up mtu "$MTU"
}


#Vijay renamed this functio to _old1 - 09/21/2025 5:20pm
start_server_for_pair_old1() {
  local IF_A="$1" PORT="$2" DEVICE="$3"
  local NS_A=$(ns_name "$IF_A")

  ip netns exec "$NS_A" bash -c "
    ulimit -n 1048576;
    ib_write_bw -d \"$DEVICE\" $ROCE_FLAG --report_gbits -F \
      $( [[ $EXCHANGES -gt 0 ]] && echo \"-n $EXCHANGES\" || echo \"-D $DURATION\" ) \
      --qp=\"$QPS\" -s \"$MSG\" --post_list=\"$PL\" \
      -p \"$PORT\" > /dev/null 2>&1 &
  "
}

#Vijay renamed this functio to _old1 - 09/21/2025 5:20pm
start_client_for_pair_old1() {
  local IF_B="$1" IP_A="$2" IP_B="$3" PORT="$4" DEVICE="$5"
  local NS_B=$(ns_name "$IF_B")

  ip netns exec "$NS_B" bash -c "
    ulimit -n 1048576;
    ib_write_bw -d \"$DEVICE\" $ROCE_FLAG --report_gbits -F \
      $( [[ $EXCHANGES -gt 0 ]] && echo \"-n $EXCHANGES\" || echo \"-D $DURATION\" ) \
      --qp=\"$QPS\" -s \"$MSG\" --post_list=\"$PL\" \
      --source_ip \"$IP_B\" \
      -p \"$PORT\" \"$IP_A\"
  "
}


#Vijay replaced the old function with the below new function.
#Added code to pin the ib_write_bw to the numa node assciated with NIC ports
#Date added: 09/21/2025 5:30pm
start_server_for_pair() {
  local IF_A="$1" PORT="$2" DEVICE="$3"
  local NS_A
  NS_A=$(ns_name "$IF_A")

  # Discover NUMA node for this netdev *inside its netns* (fallback to 0)
  local NUMA_NODE
  NUMA_NODE=$(ip netns exec "$NS_A" bash -c "cat /sys/class/net/$IF_A/device/numa_node 2>/dev/null || echo 0")
  [[ -z "$NUMA_NODE" || "$NUMA_NODE" == "-1" ]] && NUMA_NODE=0

  # Choose a small CPU set on that NUMA node (fallback to first 4 CPUs)
  local CPU_LIST=""
  if command -v lscpu >/dev/null 2>&1; then
    CPU_LIST=$(lscpu -p=CPU,NODE | awk -F, -v N="$NUMA_NODE" '$0!~/^#/ && $2==N { if (s!="") s=s","$1; else s=$1 } END{ print s }')
    [[ -z "$CPU_LIST" ]] && CPU_LIST=$(lscpu -p=CPU | awk -F, '$0!~/^#/ { if (s!="") s=s","$1; else s=$1 } END{ print s }')
  fi

  # Build optional RT/NUMA/CPU pinning wrapper
  local PREFIX=""
  if command -v chrt >/dev/null 2>&1 && command -v numactl >/dev/null 2>&1 && command -v taskset >/dev/null 2>&1 && [[ -n "$CPU_LIST" ]]; then
    PREFIX="chrt -f 80 numactl --cpunodebind=$NUMA_NODE --membind=$NUMA_NODE taskset -c $CPU_LIST"
  fi

  ip netns exec "$NS_A" bash -c "
    ulimit -n 1048576;
    $PREFIX ib_write_bw -d \"$DEVICE\" $ROCE_FLAG --report_gbits -F \
      $( [[ $EXCHANGES -gt 0 ]] && echo \"-n $EXCHANGES\" || echo \"-D $DURATION\" ) \
      --qp=\"$QPS\" -s \"$MSG\" --post_list=\"$PL\" \
      -p \"$PORT\" > /dev/null 2>&1 &
  "
}

#Vijay replaced the old function with the below new function.
#Added code to pin the ib_write_bw to the numa node assciated with NIC ports
#Date added: 09/21/2025 5:30pm
start_client_for_pair() {
  local IF_B="$1" IP_A="$2" IP_B="$3" PORT="$4" DEVICE="$5"
  local NS_B
  NS_B=$(ns_name "$IF_B")

  # Discover NUMA node for this netdev *inside its netns* (fallback to 0)
  local NUMA_NODE
  NUMA_NODE=$(ip netns exec "$NS_B" bash -c "cat /sys/class/net/$IF_B/device/numa_node 2>/dev/null || echo 0")
  [[ -z "$NUMA_NODE" || "$NUMA_NODE" == "-1" ]] && NUMA_NODE=0

  # Choose a small CPU set on that NUMA node (fallback to first 4 CPUs)
  local CPU_LIST=""
  if command -v lscpu >/dev/null 2>&1; then
    CPU_LIST=$(lscpu -p=CPU,NODE | awk -F, -v N="$NUMA_NODE" '$0!~/^#/ && $2==N { if (s!="") s=s","$1; else s=$1 } END{ print s }')
    [[ -z "$CPU_LIST" ]] && CPU_LIST=$(lscpu -p=CPU | awk -F, '$0!~/^#/ { if (s!="") s=s","$1; else s=$1 } END{ print s }')
  fi

  # Build optional RT/NUMA/CPU pinning wrapper
  local PREFIX=""
  if command -v chrt >/dev/null 2>&1 && command -v numactl >/dev/null 2>&1 && command -v taskset >/dev/null 2>&1 && [[ -n "$CPU_LIST" ]]; then
    PREFIX="chrt -f 80 numactl --cpunodebind=$NUMA_NODE --membind=$NUMA_NODE taskset -c $CPU_LIST"
  fi

  ip netns exec "$NS_B" bash -c "
    ulimit -n 1048576;
    $PREFIX ib_write_bw -d \"$DEVICE\" $ROCE_FLAG --report_gbits -F \
      $( [[ $EXCHANGES -gt 0 ]] && echo \"-n $EXCHANGES\" || echo \"-D $DURATION\" ) \
      --qp=\"$QPS\" -s \"$MSG\" --post_list=\"$PL\" \
      --source_ip \"$IP_B\" \
      -p \"$PORT\" \"$IP_A\"
  "
}





cleanup() {
  if [[ -n "${TMP_LOG:-}" && -f "$TMP_LOG" ]]; then
      rm -f "$TMP_LOG"
  fi

  echo "Cleaning up namespaces and restoring interfaces..."
  for row in "${PAIRS[@]}"; do
    read -r IF_A IF_B _ _ _ _ _ <<<"$row"
    for IFACE in "$IF_A" "$IF_B"; do
      NS="$(ns_name "$IFACE")"
      if ip netns list | grep -q "^$NS"; then
        ip netns exec "$NS" pkill -f '^ib_write_bw' || true
        ip -n "$NS" link set "$IFACE" netns 1 2>/dev/null || true
        ip netns del "$NS" 2>/dev/null || true
      fi
    done
  done

  declare -A SEEN
  for row in "${PAIRS[@]}"; do
    read -r IF_A IF_B _ _ _ _ _ <<<"$row"
    for IF in "$IF_A" "$IF_B"; do
        [[ -n "${SEEN[$IF]:-}" ]] && continue
        SEEN["$IF"]=1
        if ip link show "$IF" >/dev/null 2>&1; then
            ip link set "$IF" up || echo "Warning: failed to set '$IF' UP in root." >&2
        fi
    done
  done
  echo "Cleanup complete."
}

check_and_filter_pairs() {
  echo "Validating connectivity for all pairs..."
  WORKING_PAIRS=() # Clear the array for each run
  for row in "${PAIRS[@]}"; do
    read -r IF_A IF_B IP_A IP_B _ _ _ <<<"$row"
    local NS_B=$(ns_name "$IF_B")

    # Use a timeout to prevent long hangs on unresponsive interfaces
    if ip netns exec "$NS_B" ping -c1 -W1 "$IP_A" >/dev/null 2>&1; then
      echo "  - SUCCESS: $IF_A <-> $IF_B"
      WORKING_PAIRS+=("$row")
    else
      local LOC_A="${LOCATIONS[$IF_A]:-?}"
      local LOC_B="${LOCATIONS[$IF_B]:-?}"
      # Print error to stderr for immediate user feedback
      echo "ERROR: Connectivity check failed for pair: $IF_A (Location: $LOC_A, IP: $IP_A) <-> $IF_B (Location: $LOC_B, IP: IP_B). Skipping this pair." >&2
      # Print formatted failure lines to stdout for the final report.
      # This mimics the two test directions that would have run.
      echo "FAILURE Client($IF_B/$LOC_B/$IP_B) -> Server($IF_A/$LOC_A/$IP_A)"
      echo "FAILURE Client($IF_A/$LOC_A/$IP_A) -> Server($IF_B/$LOC_B/$IP_B)"
    fi
  done

  if [[ ${#WORKING_PAIRS[@]} -eq 0 ]]; then
    echo "Warning: Validation failed for all pairs. No benchmarks will be run." >&2
  else
    echo "Found ${#WORKING_PAIRS[@]} working pair(s). Proceeding with tests."
  fi
}

validate_interface_names() {
  local missing=0
  declare -A available_ifs
  for iface in /sys/class/net/*; do
      available_ifs["$(basename "$iface")"]=1
  done

  for row in "${PAIRS[@]}"; do
    read -r IF_A IF_B _ _ _ _ _ <<<"$row"
    for WANT in "$IF_A" "$IF_B"; do
      if [[ -z "${available_ifs[$WANT]:-}" ]]; then
        echo "ERROR: Expected interface '$WANT' not found on this system." >&2
        missing=1
      fi
    done
  done

  if (( missing )); then
    echo "Aborting. Please fix the PAIRS array to use valid interface names." >&2
    exit 1
  fi
}

setup_all() {
  validate_interface_names
  for row in "${PAIRS[@]}"; do
    read -r IF_A IF_B IP_A IP_B _ _ _ <<<"$row"
    echo "Setting up $IF_A <-> $IF_B"
    setup_pair "$IF_A" "$IF_B" "$IP_A" "$IP_B"
  done
}

run_all_benchmarks() {
  check_and_filter_pairs

  if [[ ${#WORKING_PAIRS[@]} -eq 0 ]]; then
    return # No pairs to test, so just exit the function
  fi

  # --- Direction 1: B -> A ---
  for row in "${WORKING_PAIRS[@]}"; do
    read -r IF_A _ _ _ PORT DEV_A _ <<<"$row"
    start_server_for_pair "$IF_A" "$PORT" "$DEV_A"
  done
  sleep 2
  for row in "${WORKING_PAIRS[@]}"; do
    read -r IF_A IF_B IP_A IP_B PORT _ DEV_B <<<"$row"
    local LOC_A="${LOCATIONS[$IF_A]:-?}"
    local LOC_B="${LOCATIONS[$IF_B]:-?}"
    echo "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
    echo "Running Test: Client($IF_B/$LOC_B/$IP_B) -> Server($IF_A/$LOC_A/$IP_A)"
    start_client_for_pair "$IF_B" "$IP_A" "$IP_B" "$PORT" "$DEV_B"
    echo ""
  done
  wait
  for row in "${WORKING_PAIRS[@]}"; do read -r IF_A _ _ _ _ _ _ <<<"$row"; ip netns exec "$(ns_name "$IF_A")" pkill -f '^ib_write_bw' || true; done
  sleep 1

  # --- Direction 2: A -> B ---
  for row in "${WORKING_PAIRS[@]}"; do
    read -r _ IF_B _ _ PORT _ DEV_B <<<"$row"
    start_server_for_pair "$IF_B" "$PORT" "$DEV_B"
  done
  sleep 2
  for row in "${WORKING_PAIRS[@]}"; do
    read -r IF_A IF_B IP_A IP_B PORT DEV_A _ <<<"$row"
    local LOC_A="${LOCATIONS[$IF_A]:-?}"
    local LOC_B="${LOCATIONS[$IF_B]:-?}"
    echo "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
    echo "Running Test: Client($IF_A/$LOC_A/$IP_A) -> Server($IF_B/$LOC_B/$IP_B)"
    start_client_for_pair "$IF_A" "$IP_B" "$IP_A" "$PORT" "$DEV_A"
    echo ""
  done
  wait
}

# --- SUMMARY FUNCTION ---
# MODIFIED: The gawk END block now manually calculates padding for the bandwidth
# columns to ensure alignment even when ANSI color codes are present.
print_summary() {
    gawk '
        BEGIN {
            RED = "\033[31m"
            RESET = "\033[0m"
            print "=== IB Write Bandwidth Summary (Aggregated) ==="
            printf "%-15s %-15s %-15s %-20s -> %-20s %-10s %-10s\n", "Device", "Avg BW (Gb/s)", "Peak BW (Gb/s)", "Client Interface", "Server Interface", "Client Loc", "Server Loc"
            print "---------------------------------------------------------------------------------------------------------------------------"
        }
        
        match($0, /Client\(([^/]+)\/([^/]+)\/[^)]+\) -> Server\(([^/]+)\/([^/]+)\/[^)]+\)/, arr) {
            client_if = arr[1]; client_loc = arr[2];
            server_if = arr[3]; server_loc = arr[4];
        }

        match($0, /FAILURE Client\(([^/]+)\/([^/]+)\/[^)]+\) -> Server\(([^/]+)\/([^/]+)\/[^)]+\)/, arr) {
            client_if = arr[1]; client_loc = arr[2];
            server_if = arr[3]; server_loc = arr[4];
            key = "N/A:" client_if "->" server_if

            if (! (key in is_failed)) {
                device_order[++c] = key
                device_map[key] = "N/A"
                client_if_map[key] = client_if
                server_if_map[key] = server_if
                client_loc_map[key] = client_loc
                server_loc_map[key] = server_loc
                is_failed[key] = 1
            }
            client_if = ""; server_if = ""; client_loc = ""; server_loc = ""
        }

        /Device[[:space:]]*:/ {
            device = $NF
        }

        /^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9.]+[[:space:]]+[0-9.]+/ {
            bw = $4
            key = device ":" client_if "->" server_if

            if (client_if != "" && device != "") {
                if (! (key in bw_sum)) {
                    device_order[++c] = key
                    device_map[key] = device
                    client_if_map[key] = client_if
                    server_if_map[key] = server_if
                    client_loc_map[key] = client_loc
                    server_loc_map[key] = server_loc
                }

                bw_sum[key] += bw
                bw_count[key]++

                if (bw > bw_peak[key]) {
                    bw_peak[key] = bw
                }
                
                client_if = ""; device = ""; server_if = ""; client_loc = ""; server_loc = ""
            }
        }

    END {
        for (i = 1; i <= c; i++) {
            key = device_order[i]
            
            is_f = is_failed[key]

            if (is_f) {
                avg_bw_str = RED "FAIL" RESET
                peak_bw_str = RED "FAIL" RESET
            } else {
                avg_bw = bw_sum[key] / bw_count[key]
                avg_bw_str = sprintf("%.2f", avg_bw)
                peak_bw_str = sprintf("%.2f", bw_peak[key])
            }
            
            # Manually calculate padding to handle non-printing ANSI color codes
            avg_len = is_f ? 4 : length(avg_bw_str)
            peak_len = is_f ? 4 : length(peak_bw_str)
            
            # The padding is the desired column width minus the visible length of the content
            avg_pad = 16 - avg_len > 0 ? 16 - avg_len : 1
            peak_pad = 16 - peak_len > 0 ? 16 - peak_len : 1

            # Print the summary line with manual padding
            printf "%-15s %s%*s%s%*s%-20s -> %-20s %-10s %-10s\n", 
                device_map[key], 
                avg_bw_str, avg_pad, "",
                peak_bw_str, peak_pad, "",
                client_if_map[key], server_if_map[key],
                client_loc_map[key], server_loc_map[key]
        }
    }
    '
}

# --- Main Execution ---

main() {
  DURATION="${1:-25}"
  RUN_NUM="${2:-1}"

  if ! [[ "$DURATION" =~ ^[0-9]+$ ]]; then
    echo "Error: Duration must be a positive integer." >&2
    exit 1
  fi
  if ! [[ "$RUN_NUM" =~ ^[0-9]+$ ]]; then
    echo "Error: Number of runs must be a positive integer." >&2
    exit 1
  fi

  need_root
  check_tools

  TMP_LOG=""
  trap cleanup EXIT

  echo "--- Starting RoCEv2 Loopback Benchmark ---"
  echo "Test Time: ${DURATION}s"
  echo "Number of Runs: ${RUN_NUM}"
  setup_all
  
  TMP_LOG=$(mktemp)
  if [[ ! -f "$TMP_LOG" ]]; then
      echo "Error: Could not create temporary file." >&2
      exit 1
  fi
  
  for (( i=1; i<=RUN_NUM; i++ )); do
    echo
    echo "=============== Starting Run $i of $RUN_NUM ==============="
    run_all_benchmarks
  done | tee "$TMP_LOG"
  
  echo "Test Time: ${DURATION}s"
  echo "Number of Runs: ${RUN_NUM}"
  
  echo
  echo "--- Benchmark run finished ---"
  echo

  print_summary < "$TMP_LOG"
  echo
}

main "$@"
