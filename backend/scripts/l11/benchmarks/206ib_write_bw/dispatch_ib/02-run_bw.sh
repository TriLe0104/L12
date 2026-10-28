#!/bin/bash
# ===== run_bw.sh for InfiniBand bandwidth testing =====
set -uo pipefail

usage() {
    echo "Usage: $0 --server | --client <server_ip> [--reverse]"
    echo ""
    echo "Examples:"
    echo "  Server mode:  $0 --server"
    echo "  Client mode:  $0 --client 10.10.3.10"
    echo "  Reverse mode: $0 --client 10.10.3.10 --reverse"
    exit 1
}

ROLE=""
SERVER_IP=""
REVERSE=false
NUM_RUNS=3

while [[ $# -gt 0 ]]; do
    case $1 in
        --server)
            ROLE="server"
            shift
            ;;
        --client)
            ROLE="client"
            shift
            if [[ $# -eq 0 ]]; then
                echo "Error: --client requires server IP address"
                usage
            fi
            SERVER_IP="$1"
            shift
            ;;
        --reverse)
            REVERSE=true
            shift
            ;;
        *)
            usage
            ;;
    esac
done

if [[ -z "$ROLE" ]]; then
    usage
fi

if [[ "$ROLE" == "client" && -z "$SERVER_IP" ]]; then
    echo "Error: Server IP required for client mode"
    usage
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSV_FILE="$SCRIPT_DIR/ib_topology.csv"

echo "Running $ROLE bandwidth test"

# Configure IPs for Ethernet interfaces
echo "Configuring network interfaces..."
while IFS=, read -r dev ifname port client_ip server_ip gpu_id pci_bus; do
    [[ "$dev" == "dev" ]] && continue  # Skip header
    
    # Configure IP based on role for Ethernet interfaces
    if [[ -n "$client_ip" && "$ifname" =~ ^en ]]; then
        (
            # Determine target IP based on role and reverse flag
            # In reverse mode, flip CSV column selection to keep same physical IPs
            TARGET_IP=""
            if [[ "$ROLE" == "server" ]]; then
                if $REVERSE; then
                    TARGET_IP="$client_ip"  # Use client_ip column in reverse
                else
                    TARGET_IP="$server_ip"  # Use server_ip column normally
                fi
            else  # client
                if $REVERSE; then
                    TARGET_IP="$server_ip"  # Use server_ip column in reverse
                else
                    TARGET_IP="$client_ip"  # Use client_ip column normally
                fi
            fi
            
            # Check if target IP is already assigned
            CURRENT_IP=$(ip addr show dev "$ifname" 2>/dev/null | grep -oP 'inet \K[0-9.]+(?=/)')
            
            if [[ "$CURRENT_IP" == "$TARGET_IP" ]]; then
                echo "  $ifname: $TARGET_IP (already configured)"
            else
                ip addr flush dev "$ifname" 2>/dev/null
                ip addr add "${TARGET_IP}/30" dev "$ifname" 2>/dev/null
                echo "  $ifname: $TARGET_IP"
            fi

        ) &
    fi
done < "$CSV_FILE"

# Wait for all interface configurations to complete
wait
echo "All interfaces configured"

# Kill existing ib_write_bw processes
echo "Killing existing ib_write_bw processes..."
pkill ib_write_bw || true
sleep 1

# Detect GPU vendor
GPU_VENDOR=""
if command -v nvidia-smi >/dev/null 2>&1; then
    GPU_VENDOR="nvidia"
    echo "Detected NVIDIA GPUs"
elif command -v rocm-smi >/dev/null 2>&1; then
    GPU_VENDOR="amd"
    echo "Detected AMD GPUs"
else
    echo "Warning: No GPU detected, running CPU-only tests"
fi

numa_prefix() {
  local dev="$1"
  local node
  node="$(cat "/sys/class/infiniband/${dev}/device/numa_node" 2>/dev/null || echo -1)"
  if [[ "$node" -ge 0 ]] && command -v numactl >/dev/null 2>&1; then
    echo "numactl --cpunodebind=$node --membind=$node"
  else
    echo ""
  fi
}

build_gpu_params() {
    local gpu_id="$1" gpu_bus="$2"
    [[ "$gpu_id" == "N/A" ]] && return
    
    case "$GPU_VENDOR" in
        nvidia) echo "--use_cuda $gpu_id --use_cuda_bus_id $gpu_bus --use_cuda_dmabuf" ;;
        amd) echo "--use_rocm=$gpu_id" ;;
    esac
}

run_bandwidth_test() {
    local run="$1"
    echo ""
    echo "$(printf '=%.0s' {1..60})"
    echo "=== Run $run/$NUM_RUNS ==="
    echo "$(printf '=%.0s' {1..60})"
    
    # First run Ethernet tests
    echo "Starting Ethernet (RoCE) tests..."
    while IFS=, read -r dev ifname port client_ip server_ip gpu_id pci_bus; do
        [[ "$dev" == "dev" ]] && continue  # Skip header
        [[ -z "$client_ip" ]] && continue  # Skip non-Ethernet interfaces
        
        local NP="$(numa_prefix "$dev")"
        local GPU_PARAMS="$(build_gpu_params "$gpu_id" "$pci_bus")"
        local ROCE_V2_PARAM="-x 3"
        local CMD="$NP ib_write_bw -d $dev -p $port -F -q 16 -D 10 --report_gbits $GPU_PARAMS $ROCE_V2_PARAM"
        
        if [[ "$ROLE" == "server" ]]; then
            echo "Command: $CMD &"
            eval "$CMD &"
            sleep 0.1
        else
            # Determine connection target IP based on reverse flag
            local target_ip=""
            if $REVERSE; then
                target_ip="$client_ip"
            else
                target_ip="$server_ip"
            fi
            echo "Connecting: $dev (GPU $gpu_id) -> $target_ip:$port"
            echo "Command: $CMD $target_ip"
            eval "$CMD $target_ip" || true
            echo ""
            sleep 1
        fi
    done < "$CSV_FILE"
    
    if [[ "$ROLE" == "server" ]]; then
        echo -e "\nWaiting for Ethernet tests to complete..."
        wait
        echo "Ethernet tests completed"
    fi
    
    # Then run InfiniBand tests
    echo ""
    echo "Starting InfiniBand tests..."
    while IFS=, read -r dev ifname port client_ip server_ip gpu_id pci_bus; do
        [[ "$dev" == "dev" ]] && continue  # Skip header
        [[ -n "$client_ip" ]] && continue  # Skip Ethernet interfaces
        
        local NP="$(numa_prefix "$dev")"
        local GPU_PARAMS="$(build_gpu_params "$gpu_id" "$pci_bus")"
        local CMD="$NP ib_write_bw -d $dev -p $port -F -q 16 -D 10 --report_gbits $GPU_PARAMS"
        
        if [[ "$ROLE" == "server" ]]; then
            echo "Command: $CMD &"
            eval "$CMD &"
            sleep 0.1
        else
            # For InfiniBand, always use global SERVER_IP
            local target_ip="${SERVER_IP}"
            echo "Connecting: $dev (GPU $gpu_id) -> $target_ip:$port"
            echo "Command: $CMD $target_ip"
            eval "$CMD $target_ip" || true
            echo ""
            sleep 1
        fi
    done < "$CSV_FILE"
    
    if [[ "$ROLE" == "server" ]]; then
        echo -e "\nWaiting for InfiniBand tests to complete..."
        wait
        echo "InfiniBand tests completed"
        echo "Run $run completed"
    fi
}

# Main execution
echo "$([ "$ROLE" == "server" ] && echo "Starting server listeners..." || echo "Starting client connections to $SERVER_IP...")"
echo "$(printf '=%.0s' {1..45})"

for run in $(seq 1 $NUM_RUNS); do
    run_bandwidth_test "$run"
    if [[ $run -lt $NUM_RUNS ]]; then
        WAIT_TIME=$([ "$ROLE" == "server" ] && echo 1 || echo 8)
        echo "Waiting ${WAIT_TIME}s before next run..."
        sleep $WAIT_TIME
    fi
done

if [[ "$ROLE" == "client" ]]; then
    echo ""
    echo "All tests completed!"
fi
