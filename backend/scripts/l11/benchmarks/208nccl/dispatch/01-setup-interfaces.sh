#!/bin/bash
# This script should be dispatched to each node and run to configure network interfaces
# for NCCL multi-node tests. Handles both InfiniBand and RoCE (Ethernet) interfaces.
# Migrated from benchmarks/206ib_write_bw/dispatch_ib/01-setup_infiniband.sh

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "Error: This script must be run as root (use sudo)" 
   exit 1
fi

# Check required commands
RDMA_CMD="/opt/mellanox/iproute2/sbin/rdma"
for cmd in nvidia-smi ibv_devices opensm pgrep "$RDMA_CMD"; do
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

nvidia-smi >/dev/null 2>&1 # initialize GPUs
# Step 1: Detecting GPU-NIC topology and initializing devices
echo "Step 1: Detecting GPU-NIC topology using nvidia-smi..."
TOPO_OUTPUT=$(nvidia-smi topo -mp 2>/dev/null)

if [[ -z "$TOPO_OUTPUT" ]]; then
    echo "Error: Failed to get topology from nvidia-smi"
    exit 1
fi

declare -a all_mlx5_devices
declare -A device_interfaces

# Extract mlx5 device names from topology output
while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*NIC[0-9]+:[[:space:]]+(mlx5_[0-9]+)[[:space:]]*$ ]]; then
        MLX5_DEV="${BASH_REMATCH[1]}"
        [[ " ${all_mlx5_devices[@]} " =~ " ${MLX5_DEV} " ]] || all_mlx5_devices+=("$MLX5_DEV")
    fi
done <<< "$TOPO_OUTPUT"

[[ ${#all_mlx5_devices[@]} -eq 0 ]] && { echo "Error: No mlx5 devices found"; exit 1; }

echo "Using detected mlx5 devices: ${all_mlx5_devices[*]}"
echo "Validating devices and partitioning by current state..."

# Returns current link state: UP/ACTIVE/DOWN/etc.
get_link_state() {
    local mlx5_dev="$1" iface="$2"
    if [[ "$iface" =~ ^en ]]; then
        ip link show "$iface" 2>/dev/null | grep -oP 'state \K\w+' || echo "DOWN"
    else
        rdma link show "$mlx5_dev"/1 2>/dev/null | grep -oP 'state \K\w+' | head -n1
    fi
}

# Validate devices and partition into already-up and needs-configuration in one pass
declare -a up_mlx5_devices
declare -a needs_config
for MLX5_DEV in "${all_mlx5_devices[@]}"; do
    [[ ! -d "/sys/class/infiniband/$MLX5_DEV" ]] && { echo "  $MLX5_DEV: NOT FOUND (skipping)"; continue; }

    IB_IFACE=$(ls -1 /sys/class/infiniband/$MLX5_DEV/device/net/ 2>/dev/null | head -n1)
    if [[ -z "$IB_IFACE" ]]; then
        echo "  ✗ $MLX5_DEV: No interface (skipping)"
        continue
    fi
    device_interfaces[$MLX5_DEV]="$IB_IFACE"

    LINK_STATE=$(get_link_state "$MLX5_DEV" "$IB_IFACE")
    if [[ "$IB_IFACE" =~ ^en && "$LINK_STATE" == "UP" ]] || [[ ! "$IB_IFACE" =~ ^en && "$LINK_STATE" == "ACTIVE" ]]; then
        up_mlx5_devices+=("$MLX5_DEV")
    else
        needs_config+=("$MLX5_DEV")
    fi
done

TOTAL=$(( ${#up_mlx5_devices[@]} + ${#needs_config[@]} ))
echo ""
echo "Devices found: $TOTAL  (Already up/active: ${#up_mlx5_devices[@]}  Needs configuration: ${#needs_config[@]})"
[[ $TOTAL -eq 0 ]] && { echo "Error: No valid mlx5 devices found"; exit 1; }
echo ""

echo "Step 2: Extracting Node GUIDs and setting up SMI devices..."
declare -A node_guids

# Get all GUIDs at once
while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]+(mlx5_[0-9]+)[[:space:]]+([0-9a-f]+) ]] && node_guids["${BASH_REMATCH[1]}"]="0x${BASH_REMATCH[2]}"
done < <(ibv_devices -v 2>/dev/null)

[[ ${#node_guids[@]} -eq 0 ]] && { echo "Error: No Node GUIDs found"; exit 1; }

# Setup SMI devices for IB interfaces that need configuration
for MLX5_DEV in "${needs_config[@]}"; do
    IB_IFACE="${device_interfaces[$MLX5_DEV]}"
    [[ "$IB_IFACE" =~ ^en ]] && continue

    DEV_NUM="${MLX5_DEV##*_}"
    $RDMA_CMD dev del "smi${DEV_NUM}" 2>/dev/null
    $RDMA_CMD dev add "smi${DEV_NUM}" type SMI parent "$MLX5_DEV"
    SMI_ADDED=true
done
[[ "${SMI_ADDED:-false}" == true ]] && { echo "Waiting for SMI devices to initialize..."; sleep 5; }
echo "Step 3: Starting OpenSM subnet managers..."
declare -A managed_guids
while read -r GUID; do
    managed_guids["$GUID"]=1
done < <(pgrep -a opensm | grep -oP '\-g\s+\K0x[0-9a-f]+')

[[ ${#managed_guids[@]} -gt 0 ]] && echo "Found ${#managed_guids[@]} existing OpenSM instance(s)"

STARTED_COUNT=0
for MLX5_DEV in "${needs_config[@]}"; do
    IB_IFACE="${device_interfaces[$MLX5_DEV]}"
    [[ "$IB_IFACE" =~ ^en ]] && continue

    GUID="${node_guids[$MLX5_DEV]}"
    [[ -z "$GUID" ]] && { echo "  Warning: No GUID for $MLX5_DEV"; continue; }

    if [[ -n "${managed_guids[$GUID]:-}" ]]; then
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

# Configure only interfaces that are not yet up
if [[ ${#needs_config[@]} -gt 0 ]]; then
    echo "  Configuring ${#needs_config[@]} interface(s)..."
    for MLX5_DEV in "${needs_config[@]}"; do
        IB_IFACE="${device_interfaces[$MLX5_DEV]}"
        if [[ "$IB_IFACE" =~ ^en ]]; then
            ip link set dev "$IB_IFACE" MTU 9000 up 2>/dev/null
            LINK_STATE=$(get_link_state "$MLX5_DEV" "$IB_IFACE")
            MTU=$(ip link show "$IB_IFACE" 2>/dev/null | grep -oP 'MTU \K\d+' || echo "N/A")
            if [[ "$LINK_STATE" == "UP" ]]; then
                echo "  ✓ $IB_IFACE ($MLX5_DEV): UP, MTU: $MTU"
                up_mlx5_devices+=("$MLX5_DEV")
            else
                echo "  ✗ $IB_IFACE ($MLX5_DEV): $LINK_STATE"
            fi
        else
            ip link set dev "$IB_IFACE" up 2>/dev/null
            sleep 0.5
            LINK_STATE=$(get_link_state "$MLX5_DEV" "$IB_IFACE")
            if [[ "$LINK_STATE" == "ACTIVE" ]]; then
                echo "  ✓ $IB_IFACE ($MLX5_DEV): ACTIVE"
                up_mlx5_devices+=("$MLX5_DEV")
            else
                echo "  ✗ $IB_IFACE ($MLX5_DEV): ${LINK_STATE:-DOWN}"
            fi
        fi
    done
fi

echo ""
echo "Active interfaces after configuration: ${#up_mlx5_devices[@]}"

[[ ${#up_mlx5_devices[@]} -eq 0 ]] && { echo "Warning: No interfaces are up"; exit 1; }
echo ""

# Write active device list for use by NCCL run script
printf '%s\n' "${up_mlx5_devices[@]}" > /tmp/nccl_active_devices
echo "Active devices written to /tmp/nccl_active_devices"

echo "✓ Interface configuration complete (${#up_mlx5_devices[@]} devices configured)"
