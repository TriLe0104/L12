#!/bin/bash

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "Error: This script must be run as root (use sudo)" 
   exit 1
fi

# Check required commands
RDMA_CMD="/opt/mellanox/iproute2/sbin/rdma"
for cmd in mst ibstat nvidia-smi ibv_devices opensm pgrep "$RDMA_CMD"; do
    if [[ "$cmd" == "$RDMA_CMD" ]]; then
        if [[ ! -x "$cmd" ]]; then
            echo "Error: $cmd not found or not executable"
            exit 1
        fi
    else
        if ! command -v $cmd &> /dev/null; then
            echo "Error: Required command '$cmd' not found. Please install required tools."
            exit 1
        fi
    fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="$SCRIPT_DIR/ib_topology.csv"

# IP configuration for Ethernet mode
IP_BASE=1
IP_OFFSET=100

# Parse command-line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -o)
            IP_OFFSET="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [-o IP_OFFSET]"
            exit 1
            ;;
    esac
done

IP_PREFIX="10.100.${IP_OFFSET}."

nvidia-smi >/dev/null 2>&1 # initialize GPUs
# Step 1: Detecting GPU-NIC topology and initializing devices
echo "Step 1: Detecting GPU-NIC topology using nvidia-smi..."
TOPO_OUTPUT=$(nvidia-smi topo -mp 2>/dev/null)

if [[ -z "$TOPO_OUTPUT" ]]; then
    echo "Error: Failed to get topology from nvidia-smi"
    exit 1
fi

# Parse topology once to extract all needed information
declare -A nic_gpu_map
declare -A nic_legend
declare -A affinity_score=(["PXB"]=5 ["PIX"]=4 ["PHB"]=3)
declare -a all_mlx5_devices
declare -A device_interfaces

# Two-pass parsing: First get NIC legend, then parse affinity matrix
# Pass 1: Extract NIC legend and mlx5 devices
while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*NIC([0-9]+):[[:space:]]+(mlx5_[0-9]+)[[:space:]]*$ ]]; then
        NIC_NUM="${BASH_REMATCH[1]}"
        MLX5_DEV="${BASH_REMATCH[2]}"
        nic_legend["NIC${NIC_NUM}"]="$MLX5_DEV"
        [[ " ${all_mlx5_devices[@]} " =~ " ${MLX5_DEV} " ]] || all_mlx5_devices+=("$MLX5_DEV")
    fi
done <<< "$TOPO_OUTPUT"

# Pass 2: Parse GPU affinity matrix (now that we have the legend)
while IFS= read -r line; do
    if [[ "$line" =~ ^(NIC[0-9]+)[[:space:]]+ ]]; then
        NIC_NAME="${BASH_REMATCH[1]}"
        NIC_DEV="${nic_legend[$NIC_NAME]}"
        [[ -z "$NIC_DEV" ]] && continue
        
        BEST_GPU=-1
        BEST_SCORE=0
        read -ra values <<< "$line"
        for i in {1..8}; do
            if [[ $i -lt ${#values[@]} ]]; then
                SCORE=${affinity_score[${values[$i]}]:-0}
                if [[ $SCORE -gt $BEST_SCORE ]]; then
                    BEST_SCORE=$SCORE
                    BEST_GPU=$((i - 1))
                fi
            fi
        done
        [[ $BEST_GPU -ge 0 ]] && nic_gpu_map["$NIC_DEV"]="$BEST_GPU"
    fi
done <<< "$TOPO_OUTPUT"

[[ ${#all_mlx5_devices[@]} -eq 0 ]] && { echo "Error: No mlx5 devices found"; exit 1; }

echo "Using detected mlx5 devices: ${all_mlx5_devices[*]}"
echo "Validating devices and gathering interface information..."

# Single loop to validate devices and gather all metadata
declare -a ACTIVE_MLX5_DEVICES
for MLX5_DEV in "${all_mlx5_devices[@]}"; do
    [[ ! -d "/sys/class/infiniband/$MLX5_DEV" ]] && { echo "$MLX5_DEV: NOT FOUND (skipping)"; continue; }
    
    # Get interface name
    IB_IFACE=$(ls -1 /sys/class/infiniband/$MLX5_DEV/device/net/ 2>/dev/null | head -n1)
    device_interfaces[$MLX5_DEV]="$IB_IFACE"
    ACTIVE_MLX5_DEVICES+=("$MLX5_DEV")
done

echo ""
echo "Devices to configure: ${#ACTIVE_MLX5_DEVICES[@]}"
[[ ${#ACTIVE_MLX5_DEVICES[@]} -eq 0 ]] && { echo "Error: No valid mlx5 devices found"; exit 1; }
echo ""

echo "Step 2: Extracting Node GUIDs and setting up SMI devices..."
declare -A node_guids

# Get all GUIDs at once
while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]+(mlx5_[0-9]+)[[:space:]]+([0-9a-f]+) ]] && node_guids["${BASH_REMATCH[1]}"]="0x${BASH_REMATCH[2]}"
done < <(ibv_devices -v 2>/dev/null)

[[ ${#node_guids[@]} -eq 0 ]] && { echo "Error: No Node GUIDs found"; exit 1; }

# Setup SMI devices (non-Ethernet only)
for MLX5_DEV in "${ACTIVE_MLX5_DEVICES[@]}"; do
    IB_IFACE="${device_interfaces[$MLX5_DEV]}"
    [[ "$IB_IFACE" =~ ^en ]] && continue
    
    DEV_NUM="${MLX5_DEV##*_}"
    $RDMA_CMD dev del "smi${DEV_NUM}" 2>/dev/null
    $RDMA_CMD dev add "smi${DEV_NUM}" type SMI parent "$MLX5_DEV"
done
echo "Waiting for SMI devices to initialize..."
sleep 5
echo "Step 3: Starting OpenSM subnet managers..."
declare -A managed_guids
while read -r GUID; do
    managed_guids["$GUID"]=1
done < <(pgrep -a opensm | grep -oP '\-g\s+\K0x[0-9a-f]+')

[[ ${#managed_guids[@]} -gt 0 ]] && echo "Found ${#managed_guids[@]} existing OpenSM instance(s)"

STARTED_COUNT=0
for MLX5_DEV in "${ACTIVE_MLX5_DEVICES[@]}"; do
    IB_IFACE="${device_interfaces[$MLX5_DEV]}"
    [[ "$IB_IFACE" =~ ^en ]] && continue
    
    GUID="${node_guids[$MLX5_DEV]}"
    [[ -z "$GUID" ]] && { echo "  Warning: No GUID for $MLX5_DEV"; continue; }
    
    # Check if interface is already active
    LINK_STATE=$(rdma link show $MLX5_DEV/1 2>/dev/null | grep -oP 'state \K\w+' | head -n1)
    
    if [[ "$LINK_STATE" == "ACTIVE" ]]; then
        echo "  $MLX5_DEV ($GUID): Already ACTIVE, skipping OpenSM"
    elif [[ -n "${managed_guids[$GUID]:-}" ]]; then
        echo "  $MLX5_DEV ($GUID): Already managed by OpenSM"
    else
        echo "  Starting OpenSM for $MLX5_DEV ($GUID)..."
        opensm -B -g "$GUID" &
        ((STARTED_COUNT++))
    fi
done

if [[ $STARTED_COUNT -gt 0 ]]; then
    echo "Started $STARTED_COUNT new OpenSM instance(s)"
    echo "Waiting for OpenSM to initialize..."
    sleep 15
else
    echo "No new OpenSM instances needed"
fi
echo ""

echo "Step 4: Configuring interfaces and verifying states..."

# Configure and bring up interfaces, then verify in single loop
declare -a up_mlx5_devices
for MLX5_DEV in "${ACTIVE_MLX5_DEVICES[@]}"; do
    IB_IFACE="${device_interfaces[$MLX5_DEV]}"
    [[ -z "$IB_IFACE" ]] && { echo "  ✗ $MLX5_DEV: No interface"; continue; }
    
    if [[ "$IB_IFACE" =~ ^en ]]; then
        # Ethernet: Set MTU and bring up
        ip link set dev "$IB_IFACE" MTU 9000 up 2>/dev/null
        
        LINK_STATE=$(ip link show "$IB_IFACE" 2>/dev/null | grep -oP 'state \K\w+' || echo "DOWN")
        MTU=$(ip link show "$IB_IFACE" 2>/dev/null | grep -oP 'MTU \K\d+' || echo "N/A")
        
        if [[ "$LINK_STATE" == "UP" ]]; then
            echo "  ✓ $IB_IFACE ($MLX5_DEV): UP, MTU: $MTU"
            up_mlx5_devices+=("$MLX5_DEV")
        else
            echo "  ✗ $IB_IFACE ($MLX5_DEV): $LINK_STATE"
        fi
    else
        # InfiniBand: Bring up and check RDMA state
        ip link set dev "$IB_IFACE" up 2>/dev/null
        sleep 0.5  # Brief pause for link stabilization
        LINK_STATE=$(rdma link show $MLX5_DEV/1 2>/dev/null | grep -oP 'state \K\w+' | head -n1)
        
        if [[ "$LINK_STATE" == "ACTIVE" ]]; then
            echo "  ✓ $IB_IFACE ($MLX5_DEV): ACTIVE"
            up_mlx5_devices+=("$MLX5_DEV")
        else
            echo "  ✗ $IB_IFACE ($MLX5_DEV): ${LINK_STATE:-DOWN}"
        fi
    fi
done

ACTIVE_MLX5_DEVICES=("${up_mlx5_devices[@]}")
echo ""
echo "Active interfaces after configuration: ${#ACTIVE_MLX5_DEVICES[@]}"

[[ ${#ACTIVE_MLX5_DEVICES[@]} -eq 0 ]] && { echo "Warning: No interfaces are up"; exit 0; }
echo ""

echo "Step 5: Writing topology mapping to CSV..."

# Get all GPU PCI buses at once (more efficient than per-device queries)
declare -A gpu_pci_map
while IFS=, read -r GPU_ID PCI_BUS; do
    # Trim whitespace from both fields
    GPU_ID="${GPU_ID// /}"
    PCI_BUS="${PCI_BUS// /}"
    
    # Extract bus:device.function format (remove domain prefix)
    # Handles formats like "00000000:1A:00.0" -> "1A:00.0"
    if [[ "$PCI_BUS" =~ ([0-9A-Fa-f]+:[0-9A-Fa-f]+\.[0-9]+)$ ]]; then
        PCI_BUS="${BASH_REMATCH[1]}"
    fi
    
    [[ -n "$GPU_ID" && -n "$PCI_BUS" ]] && gpu_pci_map[$GPU_ID]="$PCI_BUS"
done < <(nvidia-smi --query-gpu=index,gpu_bus_id --format=csv,noheader 2>/dev/null)

# Write CSV with all data in single loop
{
    echo "dev,ifname,port,CLIENT_IP,SERVER_IP,GPU_ID,PCI_BUS"
    PORT_NUM=18515
    IP_BASE=1
    for MLX5_DEV in "${ACTIVE_MLX5_DEVICES[@]}"; do
        IB_IFACE="${device_interfaces[$MLX5_DEV]}"
        GPU_ID="${nic_gpu_map[$MLX5_DEV]:-N/A}"
        
        # Get GPU PCI bus if we have a valid GPU ID
        if [[ "$GPU_ID" != "N/A" ]]; then
            GPU_PCI_BUS="${gpu_pci_map[$GPU_ID]:-N/A}"
        else
            GPU_PCI_BUS="N/A"
        fi
        
        # Generate IPs for Ethernet interfaces
        if [[ "$IB_IFACE" =~ ^en ]]; then
            CLIENT_IP="${IP_PREFIX}${IP_BASE}"
            SERVER_IP="${IP_PREFIX}$((IP_BASE + 1))"
            IP_BASE=$((IP_BASE + 4))
        else
            CLIENT_IP=""
            SERVER_IP=""
        fi
        
        echo "$MLX5_DEV,$IB_IFACE,$PORT_NUM,$CLIENT_IP,$SERVER_IP,$GPU_ID,$GPU_PCI_BUS"
        ((PORT_NUM++))
    done
} > "$OUTPUT_FILE"

echo "Topology mapping written to: $OUTPUT_FILE"
cat "$OUTPUT_FILE"
echo ""

echo "✓ Configuration complete (${#ACTIVE_MLX5_DEVICES[@]} devices configured)"
