#!/bin/bash
# run_two_node_ib_write_bw.sh
# Orchestrate IB write bandwidth test between two nodes
# Usage: ./run_two_node_ib_write_bw.sh <ip1> <ip2> [-e REGEX]
set -euo pipefail

if [ $# -lt 3 ] || [ $# -gt 5 ]; then
    echo "Usage: $0 <log_path> <ip1> <ip2> [-e REGEX]" >&2
    exit 1
fi

LOG_PATH=$1
IP1=$2
IP2=$3
shift 3

EXCLUDE_REGEX="ib*"
while [[ $# -gt 0 ]]; do
    case $1 in
        -e)
            EXCLUDE_REGEX="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Usage: $0 <ip1> <ip2> [-e REGEX]" >&2
            exit 1
            ;;
    esac
done

# Calculate starting port offset from last octet of IP1 * 20
LAST_OCTET=$(echo "$IP1" | awk -F. '{print $4}')
if [ -z "$LAST_OCTET" ]; then LAST_OCTET=1; fi
# Calculate IP offset from last octet of IP1
IP_OFFSET=$LAST_OCTET

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../common/get_sys_serial.sh"
source "$SCRIPT_DIR/../../common/run_remote.sh"
source "$SCRIPT_DIR/../../common/scp_pass.sh"

SERVER_START_TIME=10

LOG_SCRIPT="$SCRIPT_DIR/../../utils/rlog.sh"
# Remote paths
REMOTE_DIR="/root/testing/ib_write_bw"
REMOTE_CSV="$REMOTE_DIR/rdma_map.csv"

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_NAME="${SCRIPT_NAME%.sh}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

GRAB_SCRIPT="$REMOTE_DIR/00-grab_nic_config.sh"
CONFIG_SCRIPT="$REMOTE_DIR/01-config_links.sh"
PING_SCRIPT="$REMOTE_DIR/02-ping_test.sh"
RUN_SCRIPT="$REMOTE_DIR/03-run_bw.sh"

SCRIPT_LOG_DIR="script_logs"

# Function to flush IPs from CSV on remote
flush_ips() {
    local ip=$1
    local csv=$2
    echo "Flushing IPs on $ip"
    run_remote "$ip" "$REMOTE_DIR/04-flush_ips.sh" >> /dev/null 2>&1
}

# Run a command, always append output to log; print to stderr only on failure
run_log() {
    local log="$1"; shift
    local tmpout rc=0
    tmpout=$(mktemp)
    "$@" >"$tmpout" 2>&1 || rc=$?
    cat "$tmpout" >> "$log"
    [[ $rc -ne 0 ]] && cat "$tmpout" >&2
    rm -f "$tmpout"
    return $rc
}

# Function to run bandwidth test and display summary
run_bw_test() {
    local server_ip=$1
    local client_ip=$2
    local server_log=$3
    local client_log=$4
    local server_serial=$5
    local client_serial=$6
    local reverse_flag=$7
    
    echo "Running ib_write_bw server: $server_ip => client: $client_ip"
    echo "Starting server on $server_ip..."
    local _server_tmpout
    _server_tmpout=$(mktemp)
    run_remote "$server_ip" "$RUN_SCRIPT $reverse_flag" >"$_server_tmpout" 2>&1 &
    SERVER_PID=$!
    sleep $SERVER_START_TIME
    
    echo "Running client on $client_ip..."
    # Run client with remote_log; capture full output for summary parsing, filter verbose lines for display
    TMPOUT=$(mktemp)
    bash "$LOG_SCRIPT" -f "$client_log" "$client_ip" "$RUN_SCRIPT" $reverse_flag | tee "$TMPOUT" | grep -vE "GID:|remote address|local address"
    CLIENT_OUTPUT=$(cat "$TMPOUT")
    rm -f "$TMPOUT"
    
    echo "Waiting for server to complete..."
    local server_exit=0
    wait "$SERVER_PID" || server_exit=$?
    cat "$_server_tmpout" >> "$server_log"
    if [[ $server_exit -ne 0 ]]; then
        cat "$_server_tmpout" >&2
        echo "ERROR: Server ($server_ip) exited with code $server_exit" >&2
    fi
    rm -f "$_server_tmpout"
    echo "Server completed."

    # Parse and display summary on stderr so it surfaces through the parent wrapper
    echo "" >&2
    echo "=== IB Write Bandwidth Summary ($server_ip => $client_ip) ===" >&2
    echo "Server: $server_ip ($server_serial)" >&2
    echo "Client: $client_ip ($client_serial)" >&2
    echo "" >&2
    
    # Parse bandwidth results and format as table
    printf "%-15s  %-15s  %-15s  %-10s\n" "Device" "Avg (Gb/sec)" "Peak (Gb/sec)" "Status" >&2
    printf "%-15s  %-15s  %-15s  %-10s\n" "---------------" "---------------" "---------------" "----------" >&2
    
    awk -v threshold=388 '
    BEGIN {
        current_device = ""
    }
    # Match device name in header: "Device         : rocep153s0" or "Device : mlx5_0"
    /Device[[:space:]]*:[[:space:]]*[a-zA-Z0-9_]+/ {
        for (i=1; i<=NF; i++) {
            # Look for device names like mlx5_0, rocep153s0, etc
            if ($i ~ /^(mlx5|mlx4|qib|hfi1|irdma|rxe|rocep)[a-zA-Z0-9_]+$/) {
                current_device = $i
                if (!(current_device in device_seen)) {
                    device_list[++device_count] = current_device
                    device_seen[current_device] = 1
                }
                break
            }
        }
        next
    }
    # Match bandwidth data line: " 65536      80000            391.94             391.94               0.747558"
    # Format: #bytes #iterations BW_peak[Gb/sec] BW_average[Gb/sec] MsgRate[Mpps]
    /^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9.]+[[:space:]]+[0-9.]+/ {
        if (current_device != "" && NF >= 5) {
            peak_bw = $3
            avg_bw = $4
            
            # Track peak and average separately
            if (bw_count[current_device] == 0) {
                bw_peak_max[current_device] = peak_bw
                bw_avg_sum[current_device] = avg_bw
            } else {
                if (peak_bw > bw_peak_max[current_device]) {
                    bw_peak_max[current_device] = peak_bw
                }
                bw_avg_sum[current_device] += avg_bw
            }
            bw_count[current_device]++
        }
    }
    END {
        GREEN = "\033[32m"
        RED = "\033[31m"
        RESET = "\033[0m"
        
        # Print devices in order of appearance
        for (i = 1; i <= device_count; i++) {
            dev = device_list[i]
            if (bw_count[dev] > 0) {
                avg = bw_avg_sum[dev] / bw_count[dev]
                peak = bw_peak_max[dev]
                if (avg >= threshold) {
                    status = GREEN "PASS" RESET
                } else {
                    status = RED "FAIL" RESET
                }
                printf "%-15s  %-15.2f  %-15.2f  %s\n", dev, avg, peak, status
            }
        }
    }
    ' <<< "$CLIENT_OUTPUT" >&2
    echo "" >&2

}

# Trap to flush IPs on error or interruption after CSV generation
# Use ${CSV1:-} / ${CSV2:-} so the trap is safe even before those variables are set
trap 'if [ -f "${CSV1:-}" ] && [ -f "${CSV2:-}" ]; then flush_ips "$IP1" "$REMOTE_CSV"; flush_ips "$IP2" "$REMOTE_CSV"; fi' ERR INT

SERIAL1=$(get_sys_serial "$IP1")
SERIAL2=$(get_sys_serial "$IP2")

# Log file paths
LOG1="$LOG_PATH/$SERIAL1/206ib_write_bw/$SCRIPT_LOG_DIR/script-$SCRIPT_NAME-$TIMESTAMP.log"
LOG2="$LOG_PATH/$SERIAL2/206ib_write_bw/$SCRIPT_LOG_DIR/script-$SCRIPT_NAME-$TIMESTAMP.log"
#ib_write_bw as client log paths
LOG1_IB="$LOG_PATH/$SERIAL1/206ib_write_bw/$SCRIPT_NAME-$TIMESTAMP.log"
LOG2_IB="$LOG_PATH/$SERIAL2/206ib_write_bw/$SCRIPT_NAME-$TIMESTAMP.log"
mkdir -p "$(dirname "$LOG1")"
mkdir -p "$(dirname "$LOG2")"

# Tmp csv paths
CSV1="/tmp/$SERIAL1/interfaceMap.csv"
CSV2="/tmp/$SERIAL2/interfaceMap.csv"
mkdir -p "$(dirname "$CSV1")"
mkdir -p "$(dirname "$CSV2")"

# Ensure scripts are executable on both nodes
echo "Creating remote directories..."
run_remote "$IP1" "mkdir -p $REMOTE_DIR" >> /dev/null 2>&1
run_remote "$IP2" "mkdir -p $REMOTE_DIR" >> /dev/null 2>&1
echo "Copying scripts..."
scp_pass "$SCRIPT_DIR/dispatch/." "$REMOTE_DIR" "$IP1" "to-remote" -r
scp_pass "$SCRIPT_DIR/dispatch/." "$REMOTE_DIR" "$IP2" "to-remote" -r
echo "Setting executable permissions..."
run_log "$LOG1" run_remote "$IP1" "chmod +x $REMOTE_DIR/*.sh"
run_log "$LOG2" run_remote "$IP2" "chmod +x $REMOTE_DIR/*.sh"

# Generate CSVs on both nodes
echo "Generating NIC config on $IP1..."
GRAB_CMD="$GRAB_SCRIPT"
if [[ -n "$EXCLUDE_REGEX" ]]; then
    GRAB_CMD="$GRAB_CMD -e '$EXCLUDE_REGEX'"
fi
GRAB_CMD="$GRAB_CMD -o '$IP_OFFSET'"
run_log "$LOG1" run_remote "$IP1" "$GRAB_CMD"

echo "Generating NIC config on $IP2..."
run_log "$LOG2" run_remote "$IP2" "$GRAB_CMD"


# SCP CSVs locally for comparison
scp_pass "$CSV1" "$REMOTE_CSV" "$IP1" "to-local" > /dev/null
scp_pass "$CSV2" "$REMOTE_CSV" "$IP2" "to-local" > /dev/null

# Compare CSVs
if ! diff "$CSV1" "$CSV2" >/dev/null; then
    echo "ERROR: Asymmetric interfaces detected" >&2
    echo "" >&2
    echo "Interface differences between $IP1 ($SERIAL1) and $IP2 ($SERIAL2):" >&2
    echo "-------------------------------------------------------------------" >&2
    diff -y --width=150 "$CSV1" "$CSV2" >&2 || true
    echo "-------------------------------------------------------------------" >&2
    echo "" >&2
    flush_ips "$IP1" "$REMOTE_CSV"
    flush_ips "$IP2" "$REMOTE_CSV"
    exit 1
fi

echo "Interfaces match. Proceeding..."
echo "Interfaces configuration:"
cat "$CSV1"

# Flush IPs before starting
flush_ips "$IP1" "$REMOTE_CSV"
flush_ips "$IP2" "$REMOTE_CSV"

# Configure links
echo "Configuring links: server on $IP1, client on $IP2"
run_log "$LOG1" run_remote "$IP1" "$CONFIG_SCRIPT --server"
run_log "$LOG2" run_remote "$IP2" "$CONFIG_SCRIPT --client"

# Test connectivity
echo "Testing connectivity..."
echo "Client node ($IP2) ping test:"
run_remote "$IP2" "$PING_SCRIPT" 2>&1 | tee -a "$LOG2"
echo "Server node ($IP1) ping test:"
run_remote "$IP1" "$PING_SCRIPT" 2>&1 | tee -a "$LOG1"
echo ""

# Run bandwidth test: IP1 as server, IP2 as client
run_bw_test "$IP1" "$IP2" "$LOG1" "$LOG2_IB" "$SERIAL1" "$SERIAL2" ""
# Run reverse bandwidth test: IP2 as server, IP1 as client
run_bw_test "$IP2" "$IP1" "$LOG2" "$LOG1_IB" "$SERIAL2" "$SERIAL1" "--reverse"

# Flush IPs after completion
flush_ips "$IP1" "$REMOTE_CSV"
flush_ips "$IP2" "$REMOTE_CSV"

echo "All tests completed successfully."
echo "Done."