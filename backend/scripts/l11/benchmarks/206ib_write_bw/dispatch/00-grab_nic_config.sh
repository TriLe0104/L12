#!/usr/bin/env bash
# grab_nic_config.sh
# Map RDMA NICs to CUDA GPUs and output CSV sorted by CUDA ID / interface name
# Usage: ./grab_nic_config.sh [-e REGEX]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STARTING_PORT=19100
IP_BASE=1
IP_OFFSET=100
IP_PREFIX="10.100.${IP_OFFSET}."
EXCLUDE_REGEX=""
while [[ $# -gt 0 ]]; do
    case $1 in
        -e)
            EXCLUDE_REGEX="$2"
            shift 2
            ;;
        -o)
            IP_OFFSET="$2"
            IP_PREFIX="10.100.${IP_OFFSET}."
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [-e REGEX] [-o IP_OFFSET]"
            exit 1
            ;;
    esac
done

OUTFILE="$SCRIPT_DIR/rdma_map.csv"
echo "dev,ifname,port,client_ip,server_ip,gpu_id,gpu_bus" > "$OUTFILE"

# --- Normalize GPU BUS ---
normalize_gpu_bus() {
    local raw="$1"
    # Trim whitespace
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    # Remove 00000000: prefix if present
    echo "${raw#00000000:}"
}

# --- Normalize NIC BUS ---
normalize_nic_bus() {
    local raw="$1"                  # e.g., 0000:04:00.0
    local clean="${raw#0000:}"      # remove prefix
    local bus="${clean%%:*}"        # first byte
    local rest="${clean#*:}"        # device.func

    # Format two-digit hex
    local bus_hex=$(printf "%02X" $((16#$bus)))
    echo "${bus_hex}:${rest}"       # e.g., 04:00.0
}

# --- Read Nvidia GPUs ---
declare -A GPU_BUS    # BUS -> GPU_ID
declare -A GPU_ID_TO_BUS # GPU_ID -> BUS (for nvidia)
declare -A NIC_TO_GPU # NIC_DEV -> GPU_ID (for nvidia topology mapping)
declare -A NVIDIA_NICS # Store NICs from nvidia topology
declare GPU_VENDOR=""  # Track GPU vendor for BUS offset calculation

if command -v nvidia-smi >/dev/null 2>&1; then
    echo "=== Nvidia GPUs ==="
    GPU_VENDOR="nvidia"
    
    # Get GPU BUS information
    while IFS=, read -r GPU_ID BUS_RAW; do
        BUS=$(normalize_gpu_bus "$BUS_RAW")
        GPU_BUS[$BUS]=$GPU_ID
        GPU_ID_TO_BUS[$GPU_ID]=$BUS
    done < <(nvidia-smi --query-gpu=index,pci.bus_id --format=csv,noheader,nounits)
    
    # Parse nvidia-smi topo -m for NIC to GPU mapping
    TOPO_OUTPUT=$(nvidia-smi topo -m 2>/dev/null)
    
    if [[ -n "$TOPO_OUTPUT" ]]; then
        # Parse NIC Legend to map NIC names (e.g., NIC0) to device names (e.g., mlx5_0)
        declare -A nic_legend
        while read -r line; do
            if [[ "$line" =~ ^[[:space:]]*NIC([0-9]+):[[:space:]]*(.+)$ ]]; then
                NIC_NUM="${BASH_REMATCH[1]}"
                NIC_DEV="${BASH_REMATCH[2]}"
                nic_legend["NIC${NIC_NUM}"]="$NIC_DEV"
                NVIDIA_NICS["$NIC_DEV"]=1
            fi
        done <<< "$TOPO_OUTPUT"
        
        # Parse topology matrix to find closest GPU for each NIC
        # Priority: PXB > PIX > PHB > NODE > SYS
        declare -A affinity_score
        affinity_score["PXB"]=5
        affinity_score["PIX"]=4
        affinity_score["PHB"]=3
        affinity_score["NODE"]=2
        affinity_score["SYS"]=1
        
        # Parse each NIC row
        while read -r line; do
            if [[ "$line" =~ ^(NIC[0-9]+)[[:space:]]+ ]]; then
                NIC_NAME="${BASH_REMATCH[1]}"
                NIC_DEV="${nic_legend[$NIC_NAME]}"
                
                if [[ -z "$NIC_DEV" ]]; then
                    continue
                fi
                
                # Parse GPU affinities for this NIC
                BEST_GPU=""
                BEST_SCORE=0
                
                # Extract values for GPU0-GPU7
                read -ra values <<< "$line"
                for i in {1..8}; do
                    if [[ $i -lt ${#values[@]} ]]; then
                        AFFINITY="${values[$i]}"
                        GPU_ID=$((i - 1))
                        
                        # Get SCORE for this AFFINITY
                        SCORE=${affinity_score[$AFFINITY]:-0}
                        
                        if [[ $SCORE -gt $BEST_SCORE ]]; then
                            BEST_SCORE=$SCORE
                            BEST_GPU=$GPU_ID
                        fi
                    fi
                done
                
                if [[ -n "$BEST_GPU" ]]; then
                    NIC_TO_GPU["$NIC_DEV"]=$BEST_GPU
                fi
            fi
        done <<< "$TOPO_OUTPUT"
        
        echo "Found ${#NVIDIA_NICS[@]} NICs with GPU topology mapping"
    else
        echo "Warning: nvidia-smi topo -m failed, will use BUS offset calculation"
    fi
fi

# --- Read AMD GPUs ---
if command -v amd-smi >/dev/null 2>&1; then
    echo "=== AMD GPUs (using amd-smi) ==="
    GPU_VENDOR="amd"
    
    # Parse amd-smi output to get BDF -> HIP-ID mapping
    # Format: "| 0000:05:00.0    AMD Instinct MI355X | ..."
    #         "|   0       1       6        SPX/NPS1 | ..."
    #         where the second number (1) is HIP-ID
    
    declare -A bus_to_hip_id
    CURRENT_BUS=""
    
    while IFS= read -r line; do
        # Match BDF line: "| 0000:05:00.0    AMD Instinct MI355X |"
        if [[ "$line" =~ ^\|[[:space:]]*(0000:[0-9a-fA-F]{2}:00\.0) ]]; then
            BUS_RAW="${BASH_REMATCH[1]}"
            CURRENT_BUS=$(normalize_nic_bus "$BUS_RAW")
        # Match GPU/HIP-ID/OAM-ID line: "|   0       1       6        SPX/NPS1 |"
        elif [[ "$line" =~ ^\|[[:space:]]+[0-9]+[[:space:]]+([0-9]+)[[:space:]]+[0-9]+[[:space:]]+ ]] && [[ -n "$CURRENT_BUS" ]]; then
            HIP_ID="${BASH_REMATCH[1]}"
            bus_to_hip_id["$CURRENT_BUS"]=$HIP_ID
            GPU_BUS[$CURRENT_BUS]=$HIP_ID
            GPU_ID_TO_BUS[$HIP_ID]=$CURRENT_BUS
            echo "GPU $HIP_ID (HIP-ID) -> BUS $CURRENT_BUS"
            CURRENT_BUS=""
        fi
    done < <(amd-smi 2>/dev/null)
    
    echo ""
elif command -v rocm-smi >/dev/null 2>&1; then
    echo "=== ROCM GPUs (amd-smi not found, using rocm-smi with BUS sorting) ==="
    GPU_VENDOR="amd"
    
    # Fallback: use rocm-smi with BUS sorting
    declare -A temp_bus_to_smi_id
    
    while read -r line; do
        if [[ "$line" =~ GPU\[([0-9]+)\][[:space:]]*:[[:space:]]*PCI[[:space:]]+Bus:[[:space:]]*([0-9a-fA-F:\.]+) ]]; then
            SMI_ID="${BASH_REMATCH[1]}"
            BUS_RAW="${BASH_REMATCH[2]}"
            BUS=$(normalize_nic_bus "$BUS_RAW")
            temp_bus_to_smi_id["$BUS"]=$SMI_ID
        fi
    done < <(rocm-smi --showbus 2>/dev/null)
    
    # Sort buses and assign logical GPU IDs
    GPU_ID=0
    for BUS in $(printf '%s\n' "${!temp_bus_to_smi_id[@]}" | sort); do
        SMI_ID="${temp_bus_to_smi_id[$BUS]}"
        GPU_BUS[$BUS]=$GPU_ID
        GPU_ID_TO_BUS[$GPU_ID]=$BUS
        echo "GPU $GPU_ID (rocm-smi GPU[$SMI_ID]) -> BUS $BUS"
        ((GPU_ID++))
    done
    echo ""
fi

if [ ${#GPU_BUS[@]} -eq 0 ]; then
    echo "No GPUs detected (neither NVIDIA nor AMD)"
fi

# Replace the ibdev2netdev tool
find_rdma_nics() {
    for d in /sys/class/infiniband/*; do
        local dev=$(basename "$d")
        for p in "$d"/ports/*; do
            local port=$(basename "$p")
            local ndir="$p/gid_attrs/ndevs"
            local netdev=""
            if [ -d "$ndir" ]; then
                local nfile=$(ls "$ndir" 2>/dev/null | head -n1)
                if [ -n "$nfile" ]; then
                    netdev=$(cat "$ndir/$nfile" 2>/dev/null)
                fi
            fi
            # If still empty, try to find via netdev link
            if [ -z "$netdev" ]; then
                local netdev_link="$d/device/net"
                if [ -d "$netdev_link" ]; then
                    netdev=$(ls "$netdev_link" 2>/dev/null | head -n1)
                fi
            fi
            # Fallback to N/A
            [ -z "$netdev" ] && netdev="N/A"
            printf "%-15s port %-2s ==> %s\n" "$dev" "$port" "$netdev"
        done
    done
}

# --- Enumerate RDMA NICs ---
declare -A NIC_IFNAME
declare -A NIC_BUS
NICS=()
echo "=== RDMA NICs ==="

# For NVIDIA, use NICs from topology; for AMD or no GPU, enumerate all
if [[ "$GPU_VENDOR" == "nvidia" ]] && [[ ${#NVIDIA_NICS[@]} -gt 0 ]]; then
    NICS_TO_SCAN=("${!NVIDIA_NICS[@]}")
else
    NICS_TO_SCAN=($(ls -d /sys/class/infiniband/* 2>/dev/null | xargs -n1 basename))
fi

for nic in "${NICS_TO_SCAN[@]}"; do
    DEV_PATH="/sys/class/infiniband/$nic"
    if [[ -d "$DEV_PATH" ]]; then
        NICS+=("$nic")
        
        # Get interface name
        IFNAME=$(find_rdma_nics | grep "^$nic " | awk '{print $NF}')
        [[ -z "$IFNAME" ]] && IFNAME="N/A"
        NIC_IFNAME[$nic]=$IFNAME
        
        # Get BUS from device link
        BUS_RAW=$(readlink "$DEV_PATH/device" | xargs basename)
        BUS=$(normalize_nic_bus "$BUS_RAW")
        NIC_BUS[$nic]=$BUS
        
        echo "NIC $nic -> $IFNAME, BUS $BUS"
    fi
done

# --- Build initial CSV rows ---
PORT=0
for nic in "${NICS[@]}"; do
    BUS=${NIC_BUS[$nic]}
    IFNAME=${NIC_IFNAME[$nic]:-N/A}
    
    # Skip if IFNAME is N/A or empty
    if [[ "$IFNAME" == "N/A" || -z "$IFNAME" ]]; then
        echo "Skipping $nic (no network interface found)"
        continue
    fi
    
    # Skip if IFNAME matches exclude regex
    if [[ -n "$EXCLUDE_REGEX" && "$IFNAME" =~ $EXCLUDE_REGEX ]]; then
        echo "Skipping $IFNAME (matches exclude regex)"
        continue
    fi
    
    # Determine GPU mapping
    GPU_ID_FINAL="N/A"
    GPU_BUS_FINAL="N/A"
    MAPPING_METHOD=""
    
    if [[ "$GPU_VENDOR" == "nvidia" ]]; then
        # Use topology-based mapping (already populated in NIC_TO_GPU)
        if [[ -n "${NIC_TO_GPU[$nic]}" ]]; then
            GPU_ID_FINAL="${NIC_TO_GPU[$nic]}"
            GPU_BUS_FINAL="${GPU_ID_TO_BUS[$GPU_ID_FINAL]:-N/A}"
            MAPPING_METHOD="topology"
        else
            # Fallback to BUS offset calculation (only if topology failed)
            BUS_HEX="${BUS%%:*}"
            GPU_BUS_HEX=$(printf "%02X" $((16#$BUS_HEX - 1)))
            GPU_BUS="${GPU_BUS_HEX}:${BUS#*:}"
            GPU_ID=${GPU_BUS[$GPU_BUS]:-N/A}
            
            if [[ "$GPU_ID" != "N/A" ]]; then
                GPU_ID_FINAL=$GPU_ID
                GPU_BUS_FINAL=$GPU_BUS
                MAPPING_METHOD="BUS offset"
            fi
        fi
    elif [[ "$GPU_VENDOR" == "amd" ]]; then
        # AMD: NIC BUS - 4 = GPU BUS, then lookup HIP-ID
        BUS_HEX="${BUS%%:*}"
        GPU_BUS_HEX=$(printf "%02X" $((16#$BUS_HEX - 4)))
        GPU_BUS="${GPU_BUS_HEX}:${BUS#*:}"
        GPU_ID=${GPU_BUS[$GPU_BUS]:-N/A}
        
        if [[ "$GPU_ID" != "N/A" ]]; then
            GPU_ID_FINAL=$GPU_ID
            GPU_BUS_FINAL=$GPU_BUS
            MAPPING_METHOD="AMD HIP-ID (NIC BUS - 4)"
        fi
    fi
    
    # Print mapping result once
    if [[ -n "$MAPPING_METHOD" ]]; then
        echo "Mapping ($MAPPING_METHOD): NIC $nic -> GPU $GPU_ID_FINAL (BUS $GPU_BUS_FINAL)"
    fi

    # flush IPs for the NIC
    if [[ "$IFNAME" != "N/A" ]]; then
        ip addr flush dev "$IFNAME"
        ip link set "$IFNAME" up
    fi

    echo "${nic},${IFNAME},$((STARTING_PORT+PORT)),,,${GPU_ID_FINAL},${GPU_BUS_FINAL}" >> "$OUTFILE"
    ((PORT++))
done

# --- Sort CSV by CUDA ID (N/A last) and interface name, reassign ports ---
HEADER=$(head -n1 "$OUTFILE")
tail -n +2 "$OUTFILE" | \
awk -F, '{
    if ($6=="N/A") $6="ZZZZ"; print $0
}' OFS=, | \
sort -t, -k6,6 | \
awk -F, -v OFS=, -v HEADER="$HEADER" -v base="$STARTING_PORT" -v ip_base="$IP_BASE" -v ip_prefix="$IP_PREFIX" 'BEGIN {print HEADER} { $3=base++; $4=ip_prefix ip_base; $5=ip_prefix (ip_base+1); ip_base+=4; if($6=="ZZZZ")$6="N/A"; print }' > "${OUTFILE}.tmp"

mv "${OUTFILE}.tmp" "$OUTFILE"

echo "✅ Written and sorted mapping to: $OUTFILE"
echo
echo "=== CSV Output ==="
cat "$OUTFILE"
