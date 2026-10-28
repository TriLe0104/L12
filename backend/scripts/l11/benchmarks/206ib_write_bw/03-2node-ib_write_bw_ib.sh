#!/bin/bash
# 03-run-2node-ib_write_bw_ib.sh
# Orchestrate InfiniBand setup and bandwidth test on two nodes
# Usage: bash 03-run-2node-ib_write_bw_ib.sh <log_path> <server_ip> <client_ip>
# Example: bash 03-run-2node-ib_write_bw_ib.sh ../../racks/001 10.10.3.2 10.10.3.4
set -euo pipefail

if [ $# -ne 3 ]; then
    echo "Usage: bash $0 <log_path> <server_ip> <client_ip>"
    echo "Example: bash $0 ../../racks/001 10.10.3.2 10.10.3.4"
    exit 1
fi

LOG_PATH=$1
NODEA_IP=$2  # Primary node (runs server in first test)
NODEB_IP=$3  # Secondary node (runs client in first test)

# Extract IP offset from first node's last octet
IP_OFFSET="${NODEA_IP##*.}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../common/get_sys_serial.sh"
source "$SCRIPT_DIR/../../common/run_remote.sh"
source "$SCRIPT_DIR/../../common/scp_pass.sh"

LOG_SCRIPT="$SCRIPT_DIR/../../utils/rlog.sh"

# Remote paths
REMOTE_DIR="/root/testing/ib_setup"
CONFIGURE_SCRIPT="$REMOTE_DIR/01-setup_infiniband.sh"
RUN_SCRIPT="$REMOTE_DIR/02-run_bw.sh"

DISABLE_ACS_SCRIPT="$REMOTE_DIR/disable_acs.sh"

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_NAME="${SCRIPT_NAME%.sh}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

SERVER_START_TIME=10

# Function to run bandwidth test and display summary
run_bw_test() {
    local test_server_node=$1  # Physical IP of node running server role
    local test_client_node=$2  # Physical IP of node running client role
    local server_log=$3
    local client_log=$4
    local server_serial=$5
    local client_serial=$6
    local reverse_flag=${7:-}
    
    local server_args="--server"
    local client_args="--client $test_server_node"
    
    if [[ "$reverse_flag" == "--reverse" ]]; then
        server_args="--server --reverse"
        client_args="--client $test_server_node --reverse"
    fi
    
    echo "Running ib_write_bw server: $test_server_node => client: $test_client_node ${reverse_flag}"
    echo "Starting server on $test_server_node..."
    run_remote "$test_server_node" "$RUN_SCRIPT $server_args" >> "$server_log" 2>&1 &
    SERVER_PID=$!
    sleep $SERVER_START_TIME
    
    echo "Running client on $test_client_node..."
    # Run client with remote_log to get header/footer and capture output
    TMPOUT=$(mktemp)
    bash "$LOG_SCRIPT" -f "$client_log" "$test_client_node" "$RUN_SCRIPT" $client_args | tee "$TMPOUT" | grep -vE "GID:|remote address|local address|PCIe address is"
    CLIENT_OUTPUT=$(cat "$TMPOUT")
    rm -f "$TMPOUT"
    
    echo "Waiting for server to complete..."
    wait "$SERVER_PID"
    echo "Server completed."

    # Parse and display summary
    echo ""
    echo "=== IB Write Bandwidth Summary ($test_server_node => $test_client_node) ==="
    echo "Server: $test_server_node ($server_serial)"
    echo "Client: $test_client_node ($client_serial)"
    echo ""
    
    # Parse bandwidth results and format as table
    printf "%-15s  %-15s  %-15s  %-10s\n" "Device" "Avg (Gb/sec)" "Peak (Gb/sec)" "Status"
    printf "%-15s  %-15s  %-15s  %-10s\n" "---------------" "---------------" "---------------" "----------"
    
    awk '
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
            
            # Track overall peak as max of both peak and average columns
            # (since peak sometimes shows 0)
            if (bw_count[current_device] == 0) {
                bw_peak_max[current_device] = (peak_bw > avg_bw) ? peak_bw : avg_bw
                bw_avg_sum[current_device] = avg_bw
            } else {
                # Update peak if either column shows a higher value
                if (peak_bw > bw_peak_max[current_device]) {
                    bw_peak_max[current_device] = peak_bw
                }
                if (avg_bw > bw_peak_max[current_device]) {
                    bw_peak_max[current_device] = avg_bw
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
                
                # Determine threshold based on bandwidth range (95% of theoretical max)
                if (avg < 100) {
                    threshold = 95
                } else if (avg < 200) {
                    threshold = 190
                } else if (avg < 400) {
                    threshold = 385
                } else {
                    threshold = 780
                }
                
                if (avg >= threshold) {
                    status = GREEN "PASS" RESET
                } else {
                    status = RED "FAIL" RESET
                }
                printf "%-15s  %-15.2f  %-15.2f  %s\n", dev, avg, peak, status
            }
        }
    }
    ' <<< "$CLIENT_OUTPUT"
    echo ""
}

NODEA_SERIAL=$(get_sys_serial "$NODEA_IP")
NODEB_SERIAL=$(get_sys_serial "$NODEB_IP")

# Log file paths
# Test 1 (NODEA->NODEB): NODEA is server, NODEB gets client log with headers
NODEA_SERVER_LOG="$LOG_PATH/$NODEA_SERIAL/206ib_write_bw/script_logs/script-$SCRIPT_NAME-server-$TIMESTAMP.log"
NODEB_CLIENT_LOG="$LOG_PATH/$NODEB_SERIAL/206ib_write_bw/$SCRIPT_NAME-$TIMESTAMP.log"
# Test 2 (NODEB->NODEA): NODEB is server, NODEA gets client log with headers  
NODEB_SERVER_LOG="$LOG_PATH/$NODEB_SERIAL/206ib_write_bw/script_logs/script-$SCRIPT_NAME-server-$TIMESTAMP.log"
NODEA_CLIENT_LOG="$LOG_PATH/$NODEA_SERIAL/206ib_write_bw/$SCRIPT_NAME-$TIMESTAMP.log"
mkdir -p "$(dirname "$NODEA_SERVER_LOG")"
mkdir -p "$(dirname "$NODEB_CLIENT_LOG")"
mkdir -p "$(dirname "$NODEB_SERVER_LOG")"
mkdir -p "$(dirname "$NODEA_CLIENT_LOG")"

echo "=========================================="
echo "InfiniBand Setup and Bandwidth Test"
echo "=========================================="
echo "Node A (Primary): $NODEA_IP ($NODEA_SERIAL)"
echo "Node B (Secondary): $NODEB_IP ($NODEB_SERIAL)"
echo ""

# Step 1: Deploy scripts and configure InfiniBand
echo "Step 1: Deploying scripts and configuring InfiniBand..."
echo "------------------------------------------------------------"

# Create remote directories
run_remote "$NODEA_IP" "mkdir -p $REMOTE_DIR" >> /dev/null 2>&1
run_remote "$NODEB_IP" "mkdir -p $REMOTE_DIR" >> /dev/null 2>&1

# Copy scripts to remote nodes
scp_pass "$SCRIPT_DIR/dispatch_ib/." "$REMOTE_DIR" "$NODEA_IP" "to-remote" -r >> "$NODEA_SETUP_LOG" 2>&1
NODEB_SETUP_LOG="$LOG_PATH/$NODEB_SERIAL/206ib_write_bw/script_logs/script-setup-$TIMESTAMP.log"
mkdir -p "$(dirname "$NODEB_SETUP_LOG")"
scp_pass "$SCRIPT_DIR/dispatch_ib/." "$REMOTE_DIR" "$NODEB_IP" "to-remote" -r >> "$NODEB_SETUP_LOG" 2>&1

# Copy utility scripts
scp_pass "$SCRIPT_DIR/../../utils/node/bring_up_interface.sh" "$REMOTE_DIR/" "$NODEA_IP" "to-remote" >> "$NODEA_SETUP_LOG" 2>&1
scp_pass "$SCRIPT_DIR/../../utils/node/bring_up_interface.sh" "$REMOTE_DIR/" "$NODEB_IP" "to-remote" >> "$NODEB_SETUP_LOG" 2>&1
scp_pass "$SCRIPT_DIR/../../utils/node/disable_acs.sh" "$REMOTE_DIR/" "$NODEA_IP" "to-remote" >> "$NODEA_SETUP_LOG" 2>&1
scp_pass "$SCRIPT_DIR/../../utils/node/disable_acs.sh" "$REMOTE_DIR/" "$NODEB_IP" "to-remote" >> "$NODEB_SETUP_LOG" 2>&1

# Set executable permissions
run_remote "$NODEA_IP" "chmod +x $REMOTE_DIR/*.sh" >> "$NODEA_SETUP_LOG" 2>&1
run_remote "$NODEB_IP" "chmod +x $REMOTE_DIR/*.sh" >> "$NODEB_SETUP_LOG" 2>&1


echo "Running InfiniBand interface configuration on both nodes..."
run_remote "$NODEA_IP" "bash $CONFIGURE_SCRIPT -o $IP_OFFSET" 2>&1 | tee -a "$NODEA_SETUP_LOG" &
NODEA_CONFIG_PID=$!

run_remote "$NODEB_IP" "bash $CONFIGURE_SCRIPT -o $IP_OFFSET" 2>&1 | tee -a "$NODEB_SETUP_LOG" &
NODEB_CONFIG_PID=$!

wait $NODEA_CONFIG_PID
CONFIG_NODEA_STATUS=$?

wait $NODEB_CONFIG_PID
CONFIG_NODEB_STATUS=$?

if [ $CONFIG_NODEA_STATUS -ne 0 ]; then
    echo "✗ Node A interface configuration FAILED (exit code: $CONFIG_NODEA_STATUS)"
    exit 1
fi
if [ $CONFIG_NODEB_STATUS -ne 0 ]; then
    echo "✗ Node B interface configuration FAILED (exit code: $CONFIG_NODEB_STATUS)"
    exit 1
fi
echo "✓ Interface configuration completed on both nodes"

echo "Disabling ACS on both nodes..."
run_remote "$NODEA_IP" "bash $DISABLE_ACS_SCRIPT" 2>&1 >/dev/null | tee -a "$NODEA_SETUP_LOG" &
NODEA_ACS_PID=$!

run_remote "$NODEB_IP" "bash $DISABLE_ACS_SCRIPT" 2>&1 >/dev/null | tee -a "$NODEB_SETUP_LOG" &
NODEB_ACS_PID=$!

wait $NODEA_ACS_PID
wait $NODEB_ACS_PID
echo "✓ ACS disabled on both nodes"
echo ""

# Step 2: Run bandwidth test (NodeA as Server -> NodeB as Client)
echo "Step 2: Running bandwidth test (NodeA as Server -> NodeB as Client)..."
echo "------------------------------------------------------------"
run_bw_test "$NODEA_IP" "$NODEB_IP" "$NODEA_SERVER_LOG" "$NODEB_CLIENT_LOG" "$NODEA_SERIAL" "$NODEB_SERIAL"

# Step 3: Run bandwidth test in reverse direction (NodeB as Server -> NodeA as Client)
echo "Step 3: Running bandwidth test in reverse direction (NodeB as Server -> NodeA as Client)..."
echo "------------------------------------------------------------"
run_bw_test "$NODEB_IP" "$NODEA_IP" "$NODEB_SERVER_LOG" "$NODEA_CLIENT_LOG" "$NODEB_SERIAL" "$NODEA_SERIAL" "--reverse"

echo "=========================================="
echo "Test Complete"
echo "=========================================="
echo ""
echo "Logs saved to:"
echo "  NodeA -> NodeB:"
echo "    NodeA (server): $NODEA_SERVER_LOG"
echo "    NodeB (client): $NODEB_CLIENT_LOG"
echo "    NodeB setup: $NODEB_SETUP_LOG"
echo ""
echo "  NodeB -> NodeA:"
echo "    NodeB (server): $NODEB_SERVER_LOG"
echo "    NodeA (client): $NODEA_CLIENT_LOG"
echo ""
echo "InfiniBand setup and bandwidth test completed successfully."
