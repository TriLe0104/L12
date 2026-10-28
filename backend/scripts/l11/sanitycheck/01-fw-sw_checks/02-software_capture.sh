#!/bin/bash

# --- 0. VALIDATE INPUT & SET UP ---
FORCE_GOLDEN=0
while [[ "$1" == --* ]]; do
    case "$1" in
        --golden) FORCE_GOLDEN=1 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

if [[ $# -lt 2 || $# -gt 3 ]]; then
    echo "Usage: $0 [--golden] <BASE_LOG_DIR> <OS_IP> [TIMESTAMP]" >&2
    exit 1
fi

BASE_LOG_DIR="$1"
OS_IP="$2"
TIMESTAMP=${3:-$(date +%Y%m%d%H%M%S)}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR_NAME=$(basename "$SCRIPT_DIR")
EXPECTED_CSV_PATH="$SCRIPT_DIR/../../data/sw_golden.csv"

# --- Source libraries ---
# shellcheck source=../../common/get_sys_serial.sh
source "$SCRIPT_DIR/../../common/get_sys_serial.sh"

# --- GET SYSTEM SERIAL NUMBER ---
SYS_SN=$(get_sys_serial "$OS_IP")

# --- FIND THE LATEST LOG DIRECTORY ---
SEARCH_PATH="$BASE_LOG_DIR/$SYS_SN/101infosystem"
LOG_DIR=$(find "$SEARCH_PATH" -maxdepth 1 -type d -name "${DIR_NAME}_${TIMESTAMP}*" | sort | tail -n 1)
if [[ -z "$LOG_DIR" ]]; then
    # Create directory with the provided TIMESTAMP
    LOG_DIR="$SEARCH_PATH/${DIR_NAME}_${TIMESTAMP}"
    mkdir -p "$LOG_DIR"
fi
LOG_FILE="$LOG_DIR/02-software_capture_${TIMESTAMP}.csv"

# --- 1. GATHER ACTUAL SYSTEM INFO ---
OS_NAME=$(run_remote "$OS_IP" "grep PRETTY_NAME /etc/os-release | cut -d'\"' -f2")
KERNEL_VERSION=$(run_remote "$OS_IP" "uname -r")

# Detect GPU type (NVIDIA or AMD)
GPU_DRIVER=""
GPGPU=""

# Check for NVIDIA GPU
if run_remote "$OS_IP" "command -v nvidia-smi >/dev/null 2>&1"; then
    nvidia_driver=$(run_remote "$OS_IP" "nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits 2>/dev/null | head -1")
    GPU_DRIVER="$nvidia_driver"
    # Get CUDA version from nvidia-smi
    cuda_version=$(run_remote "$OS_IP" "nvidia-smi | grep -oP 'CUDA Version: \K[0-9]+\.[0-9]+' | head -1")
    if [[ -z "$cuda_version" ]]; then
        GPGPU="CUDA N/A"
    else
        GPGPU="CUDA $cuda_version"
    fi
# Check for AMD GPU
elif run_remote "$OS_IP" "command -v amd-smi >/dev/null 2>&1"; then
    amdsmi_output=$(run_remote "$OS_IP" "amd-smi 2>/dev/null | head -n 2 | tail -n 1")
    amd_driver=$(echo "$amdsmi_output" | awk '{print $6}')
    rocm_version=$(echo "$amdsmi_output" | awk '{print $9}')
    GPU_DRIVER="amdgpu $amd_driver"
    GPGPU="ROCm $rocm_version"
else
    GPU_DRIVER="N/A"
    GPGPU="N/A"
fi

declare -A unique_nics
# Note: We must not quote the command inside the loop variable
NIC_LIST=$(run_remote "$OS_IP" "ls /sys/class/net")
for nic in $NIC_LIST; do
    # Skip virtual interfaces (veth, br-, docker, virbr, etc.)
    if [[ "$nic" =~ ^(veth|br-|docker|virbr|tap|tun|vnet) ]]; then
        continue
    fi
    
    # Check if this is a physical device (has a device symlink)
    device_path=$(run_remote "$OS_IP" "readlink -f /sys/class/net/$nic/device 2>/dev/null")
    if [[ -z "$device_path" ]]; then
        # No device link means it's a virtual interface
        continue
    fi
    
    ethtool_output=$(run_remote "$OS_IP" "ethtool -i $nic 2>/dev/null")
    driver=$(echo "$ethtool_output" | grep "driver:" | awk '{print $2}')
    if [[ "$driver" == "i40e" || "$driver" == "rndis_host" || "$driver" == "bridge" || "$driver" == "tun" || "$driver" == "veth" || "$driver" == "" || "$driver" == "lo" ]]; then
        continue
    fi
    driver_version=$(echo "$ethtool_output" | grep "^version:" | awk '{print $2}')
    firmware_version=$(echo "$ethtool_output" | grep "firmware-version:" | awk '{print $2}')
    
    # Get NIC part number from VPD or DMI
    pci_path=$(run_remote "$OS_IP" "readlink -f /sys/class/net/$nic/device 2>/dev/null")
    if [[ -n "$pci_path" ]]; then
        # Try to get PN from VPD with multiple methods
        part_number=$(run_remote "$OS_IP" "lspci -vv -s \$(basename ${pci_path}) 2>/dev/null | grep -oP 'Part number:\s*\K[A-Z0-9-]+' | head -1")
        if [[ -z "$part_number" ]]; then
            part_number=$(run_remote "$OS_IP" "cat ${pci_path}/vpd 2>/dev/null | strings | grep -E '^PN' | cut -d' ' -f2 | head -1")
        fi
        if [[ -z "$part_number" ]]; then
            # Try reading subsystem device name
            part_number=$(run_remote "$OS_IP" "lspci -vv -s \$(basename ${pci_path}) 2>/dev/null | grep 'Subsystem:' | grep -oP '\[([A-Z0-9-]+)\]' | tr -d '[]' | tail -1")
        fi
        if [[ -z "$part_number" ]]; then
            # Final fallback to subsystem IDs
            subsystem_vendor=$(run_remote "$OS_IP" "cat ${pci_path}/subsystem_vendor 2>/dev/null")
            subsystem_device=$(run_remote "$OS_IP" "cat ${pci_path}/subsystem_device 2>/dev/null")
            if [[ -n "$subsystem_vendor" && -n "$subsystem_device" ]]; then
                part_number="${subsystem_vendor}:${subsystem_device}"
            else
                part_number="UNKNOWN"
            fi
        fi
    else
        part_number="UNKNOWN"
    fi
    
    unique_key="${part_number}_${driver}"
    unique_nics["$unique_key"]="$part_number,$driver $driver_version,$firmware_version"
done

# --- 2. BUILD ACTUAL DATA STRING & SAVE CSV ---
ACTUAL_DATA_STATIC="$OS_NAME,$KERNEL_VERSION,$GPU_DRIVER,$GPGPU"
ACTUAL_DATA_NICS=""
SORTED_KEYS=$(echo "${!unique_nics[@]}" | tr ' ' '\n' | sort)
for key in $SORTED_KEYS; do
    if [ -z "$ACTUAL_DATA_NICS" ]; then
        ACTUAL_DATA_NICS="${unique_nics[$key]}"
    else
        ACTUAL_DATA_NICS+=","${unique_nics[$key]}""
    fi
done
ACTUAL_DATA="$ACTUAL_DATA_STATIC,$ACTUAL_DATA_NICS"
# Trim all whitespace including linebreaks
ACTUAL_DATA=$(echo "$ACTUAL_DATA" | tr -d '\r\n')

# Generate header dynamically
GENERATED_HEADER="OS,Kernel,GPU Driver,GPGPU"
NIC_COUNT=1
for key in $SORTED_KEYS; do
    GENERATED_HEADER+=",NIC #${NIC_COUNT} Part,NIC #${NIC_COUNT} Driver,NIC #${NIC_COUNT} Firmware"
    ((NIC_COUNT++))
done

echo "$GENERATED_HEADER" > "$LOG_FILE"
echo "$ACTUAL_DATA" >> "$LOG_FILE"

# --- 3. LOAD EXPECTED DATA IF IT EXISTS ---
if [[ $FORCE_GOLDEN -eq 1 ]]; then
    echo "Force-updating golden software reference (--golden flag)"
    mkdir -p "$(dirname "$EXPECTED_CSV_PATH")"
    cp "$LOG_FILE" "$EXPECTED_CSV_PATH"
    echo "Golden software saved to: $EXPECTED_CSV_PATH"
    exit 82
fi

if [ -f "$EXPECTED_CSV_PATH" ]; then
    expected_data=$(tail -n 1 "$EXPECTED_CSV_PATH" | tr -d '\r\n')
    expected_header=$(head -n 1 "$EXPECTED_CSV_PATH" | tr -d '\r\n')
    echo "Expected file: $EXPECTED_CSV_PATH"
    echo "Actual file:   $LOG_FILE"
else
    echo "Warning: Golden software file not found at $EXPECTED_CSV_PATH" >&2
    echo "Capturing current state as new golden reference." >&2
    # Create directory for golden file
    mkdir -p "$(dirname "$EXPECTED_CSV_PATH")"
    # Copy current capture as golden
    cp "$LOG_FILE" "$EXPECTED_CSV_PATH"
    echo "Golden software saved to: $EXPECTED_CSV_PATH" >&2
    echo "Software capture completed successfully." >&2
    exit 82
fi

# --- 4. ROBUST ORDER-INDEPENDENT COMPARISON ---
create_canonical_nics() {
    local nics_csv=$1
    IFS=',' read -r -a nics_arr <<< "$nics_csv"
    local triplets=()
    # Each NIC has 3 fields: Part, Driver, Firmware
    for ((i=0; i<${#nics_arr[@]}; i+=3)); do
        # Ensure we have a complete triplet
        if [ -n "${nics_arr[i+2]}" ]; then
            triplets+=("${nics_arr[i]},${nics_arr[i+1]},${nics_arr[i+2]}")
        fi
    done
    printf "%s\n" "${triplets[@]}" | sort | paste -sd, -
}

EXPECTED_STATIC=$(echo "$expected_data" | cut -d, -f1-4)
ACTUAL_STATIC=$(echo "$ACTUAL_DATA" | cut -d, -f1-4)
EXPECTED_NICS=$(echo "$expected_data" | cut -d, -f5-)
ACTUAL_NICS=$(echo "$ACTUAL_DATA" | cut -d, -f5-)
EXPECTED_NICS_SORTED=$(create_canonical_nics "$EXPECTED_NICS")
ACTUAL_NICS_SORTED=$(create_canonical_nics "$ACTUAL_NICS")

# --- 5. FINAL REPORTING AND EXIT ---
if [ "$ACTUAL_STATIC" == "$EXPECTED_STATIC" ] && [ "$ACTUAL_NICS_SORTED" == "$EXPECTED_NICS_SORTED" ]; then
    exit 0
else
    # On failure, print the detailed mismatch report to standard error
    (
    echo "FAIL"
    echo "Expected file: $EXPECTED_CSV_PATH" 
    echo "Actual file:   $LOG_FILE"
    echo "-----------------------------------------"
    echo "Mismatches found:"

    IFS=',' read -r -a expected_arr <<< "$expected_data"
    IFS=',' read -r -a actual_arr <<< "$ACTUAL_DATA"
    IFS=',' read -r -a header_arr <<< "$expected_header"

    # Use the header count as the basis for the loop to avoid index out of bounds
    for i in "${!header_arr[@]}"; do
        # Use defaults for missing values to prevent unbound variable errors
        expected_val="${expected_arr[$i]:-EMPTY}"
        actual_val="${actual_arr[$i]:-EMPTY}"

        if [ "$expected_val" != "$actual_val" ]; then
            echo "  - ${header_arr[$i]}:"
            echo "    - Expected: ${expected_val}"
            echo "    - Actual:   ${actual_val}"
        fi
    done
    echo "-----------------------------------------"
    ) >&2
    exit 1
fi