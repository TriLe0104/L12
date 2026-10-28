#!/bin/bash
# 02-run-multi-node-nccl.sh
# Orchestrator for multi-node NCCL tests with full system configuration
# Usage: ./02-run-multi-node-nccl.sh <log_path> <ip1> <ip2> [ip3] ...

set -euo pipefail

echo "Setting up and running multi-node NCCL tests..."

# Check if at least log path and two IP addresses are provided
if [ $# -lt 3 ]; then
    echo "ERROR: Log path and at least 2 IP addresses required"
    echo "Usage: $0 <log_path> <ip1> <ip2> [ip3] ..."
    exit 1
fi

LOG_PATH=$1
shift
ALL_IPS=("$@")
MASTER_IP="${ALL_IPS[0]}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPTS_DIR="$SCRIPT_DIR/../../utils/node"
LOG_SCRIPT="$SCRIPT_DIR/../../utils/rlog.sh"
SCRIPT_LOG_DIR="script_logs"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=3"

# Source helper functions
source "$SCRIPT_DIR/../../common/run_remote.sh"
source "$SCRIPT_DIR/../../common/get_sys_serial.sh"
source "$SCRIPT_DIR/../../common/get_sys_hostname.sh"

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_NAME="${SCRIPT_NAME%.sh}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NUM_NODES=${#ALL_IPS[@]}
LOG_FILE_NAME=$SCRIPT_NAME-$NUM_NODES-$TIMESTAMP

echo "Master node: $MASTER_IP"
echo "All nodes: ${ALL_IPS[@]}"
echo ""

# ============================================================================
# Step 1: Configure passwordless SSH (host-to-node and node-to-node)
# ============================================================================
echo "=== Configuring passwordless SSH ==="

SSH_HOST_TO_NODES_SCRIPT="$SCRIPT_DIR/../../utils/setup_ssh_host_to_nodes.sh"
SSH_NODE_TO_NODE_SCRIPT="$SCRIPT_DIR/../../utils/setup_ssh_node_to_node.sh"

if [ ! -f "$SSH_HOST_TO_NODES_SCRIPT" ] || [ ! -f "$SSH_NODE_TO_NODE_SCRIPT" ]; then
    echo "ERROR: SSH setup scripts not found in utils/" >&2
    exit 1
fi

export PASS
echo "Setting up host-to-node passwordless SSH..."
if ! bash "$SSH_HOST_TO_NODES_SCRIPT" "${ALL_IPS[@]}"; then
    echo "ERROR: Failed to configure host-to-node passwordless SSH" >&2
    exit 1
fi
echo "✓ Host-to-node passwordless SSH configured successfully"

echo "Setting up node-to-node passwordless SSH..."
if ! bash "$SSH_NODE_TO_NODE_SCRIPT" "${ALL_IPS[@]}"; then
    echo "ERROR: Failed to configure node-to-node passwordless SSH" >&2
    exit 1
fi
echo "✓ Node-to-node passwordless SSH configured successfully"
echo ""

# ============================================================================
# Step 2: Get serial numbers and create log directories
# ============================================================================
echo "=== Gathering node information and creating log directories ===" 
declare -A NODE_LOGS
declare -A NODE_NCCL_LOGS
declare -A NODE_SNS
declare -A NODE_HOSTNAMES

for ip in "${ALL_IPS[@]}"; do
    echo "Getting serial number for $ip..."
    SERIAL=$(get_sys_serial "$ip")
    NODE_SNS["$ip"]="$SERIAL"
    echo "Getting hostname for $ip..."
    HOSTNAME=$(get_sys_hostname "$ip")
    NODE_HOSTNAMES["$ip"]="$HOSTNAME"
    LOG_DIR="$LOG_PATH/$SERIAL/$(basename "$SCRIPT_DIR")"
    mkdir -p "$LOG_DIR"
    mkdir -p "$LOG_DIR/$SCRIPT_LOG_DIR"
    NODE_NCCL_LOGS["$ip"]="$LOG_DIR/$LOG_FILE_NAME.log"
    NODE_LOGS["$ip"]="$LOG_DIR/$SCRIPT_LOG_DIR/script-$LOG_FILE_NAME.log"
    echo "  ✓ $ip ($SERIAL): ${NODE_LOGS[$ip]}"
done

MASTER_LOG="${NODE_LOGS[$MASTER_IP]}"
MASTER_NCCL_LOG="${NODE_NCCL_LOGS[$MASTER_IP]}"
echo ""

# ============================================================================
# Step 3: Copy dispatch scripts to nodes
# ============================================================================
echo "=== Copying dispatch scripts to nodes ===" | tee -a "$MASTER_LOG"

# Copy 01-setup-interfaces.sh to ALL nodes
for ip in "${ALL_IPS[@]}"; do
    scp $SSH_OPTS "$SCRIPT_DIR/dispatch/01-setup-interfaces.sh" "root@$ip:/tmp/01-setup-interfaces.sh" >> "$MASTER_LOG" 2>&1
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to copy 01-setup-interfaces.sh to $ip" | tee -a "$MASTER_LOG"
        exit 1
    fi
done
echo "✓ 01-setup-interfaces.sh copied to all nodes" | tee -a "$MASTER_LOG"

# ============================================================================
# Step 4: System Configuration
# Configures: interface configuration, ACS disable
# ============================================================================
echo "=== Configuring network interfaces and ACS in parallel ===" | tee -a "$MASTER_LOG"
declare -A config_pids
for ip in "${ALL_IPS[@]}"; do
    NODE_LOG="${NODE_LOGS[$ip]}"
    (
        echo "Configuring interfaces on $ip..." | tee -a "$NODE_LOG"
        CONFIG_FAILED=false
        # Configure network interfaces using dispatch script
        if ! ssh $SSH_OPTS "root@$ip" "bash /tmp/01-setup-interfaces.sh" >> "$NODE_LOG" 2>&1; then
            echo "ERROR: Failed to configure interfaces on $ip" | tee -a "$NODE_LOG" >&2
            CONFIG_FAILED=true
        fi
        
        # Disable ACS
        echo "Disabling ACS on $ip..." | tee -a "$NODE_LOG"
        if ! bash "$NODE_SCRIPTS_DIR/disable_acs.sh" "$ip" >> "$NODE_LOG" 2>&1; then
            echo "ERROR: Failed to disable ACS on $ip" | tee -a "$NODE_LOG" >&2
            CONFIG_FAILED=true
        fi
        
        if [ "$CONFIG_FAILED" = true ]; then
            echo "Node $ip configuration FAILED" | tee -a "$NODE_LOG" >&2
            exit 1
        else
            echo "Node $ip configured successfully" | tee -a "$NODE_LOG"
        fi
    ) &
    config_pids["$ip"]=$!
done

# Wait for all background jobs and check their exit status
CONFIG_ERRORS=0
for ip in "${ALL_IPS[@]}"; do
    if ! wait "${config_pids[$ip]}"; then
        echo "ERROR: Configuration failed for $ip" | tee -a "$MASTER_LOG" >&2
        ((CONFIG_ERRORS++))
    fi
done
    
if [ $CONFIG_ERRORS -eq 0 ]; then
    echo "✓ All nodes configured successfully" | tee -a "$MASTER_LOG"
else
    echo "ERROR: Configuration failed for $CONFIG_ERRORS node(s)" | tee -a "$MASTER_LOG" >&2
    exit 1
fi
echo "" | tee -a "$MASTER_LOG"

# Run the NCCL multi-node test on master node with all IPs as arguments
echo "=== Running NCCL multi-node tests on master node $MASTER_IP ===" | tee -a "$MASTER_LOG"

bash "$LOG_SCRIPT" -f "$MASTER_NCCL_LOG" "$MASTER_IP" "$SCRIPT_DIR/dispatch/02-run_nccl-multi.sh" "${ALL_IPS[@]}" || true
EXIT_CODE=$?

# Add multi-node specific metadata to the log
PEER_SNS=""
for ip in "${ALL_IPS[@]}"; do
    PEER_SERIAL="${NODE_SNS[$ip]}"
    if [ -z "$PEER_SNS" ]; then
        PEER_SNS="$PEER_SERIAL"
    else
        PEER_SNS="$PEER_SNS, $PEER_SERIAL"
    fi
done

# Create a temporary file with the additions
TEMP_FILE=$(mktemp)
while IFS= read -r line; do
    echo "$line"
    if [[ "$line" =~ ^System\ SN ]]; then
        echo "Num Nodes  : $NUM_NODES"
        echo "Peer SN    : $PEER_SNS"
    fi
done < "$MASTER_NCCL_LOG" > "$TEMP_FILE"

# Replace the original file
mv "$TEMP_FILE" "$MASTER_NCCL_LOG"

# Copy master NCCL log to all participating nodes
echo "" | tee -a "$MASTER_LOG"
echo "=== Distributing NCCL results to all nodes ===" | tee -a "$MASTER_LOG"
for ip in "${ALL_IPS[@]}"; do
    NODE_NCCL_LOG="${NODE_NCCL_LOGS[$ip]}"
    if [ "$ip" != "$MASTER_IP" ]; then
        echo "Copying NCCL results to $ip: $NODE_NCCL_LOG" | tee -a "$MASTER_LOG"
        cp "$MASTER_NCCL_LOG" "$NODE_NCCL_LOG"
        # Update System SN and Hostname in the copied log
        sed -i "s/^System SN.*/System SN  : ${NODE_SNS[$ip]}/" "$NODE_NCCL_LOG"
        sed -i "s/^Hostname.*/Hostname   : ${NODE_HOSTNAMES[$ip]}/" "$NODE_NCCL_LOG"
    fi
done
echo "NCCL results distributed successfully" | tee -a "$MASTER_LOG"

echo "" | tee -a "$MASTER_LOG"
echo "Logs saved to:" | tee -a "$MASTER_LOG"
for ip in "${ALL_IPS[@]}"; do
    echo "  $ip: ${NODE_LOGS[$ip]}" | tee -a "$MASTER_LOG"
    echo "  $ip: ${NODE_NCCL_LOGS[$ip]}" | tee -a "$MASTER_LOG"
done

exit $EXIT_CODE
