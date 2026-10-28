#!/bin/bash

# Parse JSON sanity check report and format like L10 report
# Usage: ./02-parse_json.sh <json_file>
# Output is written to <json_file>.l10



JSON_FILE="${1}"
OUTPUT_FILE="${JSON_FILE%.*}.l10"

# Check if JSON file exists
if [[ ! -f "$JSON_FILE" ]]; then
    echo "Error: JSON file not found: $JSON_FILE" >&2
    exit 1
fi

# Check if jq is installed2
if ! command -v jq &> /dev/null; then
    echo "Error: jq is not installed. Please install jq to parse JSON." >&2
    exit 1
fi

# Function to write output
write_output() {
    if [[ -n "$OUTPUT_FILE" ]]; then
        echo "$1" >> "$OUTPUT_FILE"
    else
        echo "$1"
    fi
}

# Function to log warnings to stderr
warn() {
    echo "[WARN] $1" >&2
}

# Clear output file if specified
if [[ -n "$OUTPUT_FILE" ]]; then
    > "$OUTPUT_FILE"
fi

# Extract JSON data using jq
HOSTNAME=$(jq -r '.system.hostname // "N/A"' "$JSON_FILE")
[[ "$HOSTNAME" == "N/A" ]] && warn "Failed to parse system hostname"
SYSTEM_SN=$(jq -r '.system.system_sn // "N/A"' "$JSON_FILE")
[[ "$SYSTEM_SN" == "N/A" ]] && warn "Failed to parse system serial number"
SYSTEM_PN=$(jq -r '.system.system_pn // "N/A"' "$JSON_FILE")
[[ "$SYSTEM_PN" == "N/A" ]] && warn "Failed to parse system part number"
CHASSIS_SN=$(jq -r '.system.chassis_sn // "N/A"' "$JSON_FILE")
[[ "$CHASSIS_SN" == "N/A" ]] && warn "Failed to parse chassis serial number"
CHASSIS_PN=$(jq -r '.system.chassis_pn // "N/A"' "$JSON_FILE")
#[[ "$CHASSIS_PN" == "N/A" ]] && warn "Failed to parse chassis part number" # It is always missing
BMC_MAC=$(jq -r '.network_bmc.mac // "N/A"' "$JSON_FILE")
[[ "$BMC_MAC" == "N/A" ]] && warn "Failed to parse BMC MAC address"
CPLD_VERSION=$(jq -r '.firmware.cpld_version // "N/A"' "$JSON_FILE")
[[ "$CPLD_VERSION" == "N/A" ]] && warn "Failed to parse CPLD version"
BIOS_VERSION=$(jq -r '.firmware.bios_version // "N/A"' "$JSON_FILE")
[[ "$BIOS_VERSION" == "N/A" ]] && warn "Failed to parse BIOS version"
BMC_VERSION=$(jq -r '.firmware.bmc_version // "N/A"' "$JSON_FILE")
[[ "$BMC_VERSION" == "N/A" ]] && warn "Failed to parse BMC version"
BUNDLE_VERSION=$(jq -r '.firmware.bkc_version // "N/A"' "$JSON_FILE")
MB_PN=$(jq -r '.system.motherboard.part_number // "N/A"' "$JSON_FILE")
[[ "$MB_PN" == "N/A" ]] && warn "Failed to parse motherboard part number"
MB_SN=$(jq -r '.system.motherboard.serial_number // "N/A"' "$JSON_FILE")
[[ "$MB_SN" == "N/A" ]] && warn "Failed to parse motherboard serial number"
CPU_MODEL=$(jq -r '.cpu.info.model // "N/A"' "$JSON_FILE" | sed 's/;$//')
[[ "$CPU_MODEL" == "N/A" ]] && warn "Failed to parse CPU model"
CPU_COUNT_RAW=$(jq -r '.cpu.info.counts // "N/A"' "$JSON_FILE")
# Extract just the socket count (first number before "Sockets")
CPU_COUNT=$(echo "$CPU_COUNT_RAW" | grep -oE '^[0-9]+' || echo "N/A")
[[ "$CPU_COUNT" == "N/A" ]] && warn "Failed to parse CPU socket count from: '$CPU_COUNT_RAW'"

# Extract memory in GB - calculate from individual module sizes for accuracy
# First try to calculate from modules, fall back to summary if not available
MEM_GB=$(jq -r '[.memory.modules[].size | select(type == "string" and test("^[0-9]+ GB$")) | gsub(" GB";"") | tonumber] | add // 0' "$JSON_FILE")
if [[ ! "$MEM_GB" =~ ^[0-9]+$ ]] || [[ -z "$MEM_GB" ]]; then
    warn "Failed to calculate total memory from module sizes, falling back to summary field"
    # Fall back to extracting from summary
    MEM_SUMMARY=$(jq -r '.memory.summary // "N/A"' "$JSON_FILE")
    MEM_GB=$(echo "$MEM_SUMMARY" | grep -oE '[0-9]+' | head -1)
fi
if [[ ! "$MEM_GB" =~ ^[0-9]+$ ]]; then
    warn "Failed to parse total memory from summary field, defaulting to 0"
    MEM_GB=0
fi
DIMM_COUNT=$(jq -r '[.memory.modules[] | select(.size | type == "string" and test("^[0-9]+ GB$"))] | length' "$JSON_FILE")
[[ "$DIMM_COUNT" -eq 0 ]] && warn "Failed to parse DIMM count or no memory modules found"

# Get unique memory part number from first installed module - clean up any extra suffix (e.g., " MWFF")
DIMM_PN=$(jq -r '[.memory.modules[] | select(.size | type == "string" and test("^[0-9]+ GB$"))][0].part_number // "N/A" | gsub(" [A-Z]+$";"")' "$JSON_FILE")
[[ "$DIMM_PN" == "N/A" ]] && warn "Failed to parse DIMM part number"

# Get storage info - aggregate by model
declare -A STORAGE_MODELS
while IFS= read -r model; do
    STORAGE_MODELS["$model"]=$((${STORAGE_MODELS["$model"]:-0} + 1))
done < <(jq -r '.storage[].model // "N/A"' "$JSON_FILE")
[[ ${#STORAGE_MODELS[@]} -eq 0 ]] && warn "Failed to parse storage devices or no storage found"

# Get GPU info - use 'name' field and extract serial from 'serial' field
GPU_COUNT=$(jq -r '.accelerators_gpu.devices | length' "$JSON_FILE")
[[ "$GPU_COUNT" -eq 0 ]] && warn "Failed to parse GPU devices or no GPUs found"
GPU_MODEL=$(jq -r '.accelerators_gpu.devices[0].name' "$JSON_FILE")
[[ -z "$GPU_MODEL" || "$GPU_MODEL" == "null" ]] && warn "Failed to parse GPU model name"

# Get NIC info
NIC_INTERFACES=$(jq -r '.network_interfaces | length' "$JSON_FILE")
[[ "$NIC_INTERFACES" -eq 0 ]] && warn "Failed to parse network interfaces or none found"

# Get PSU info
PSU_MODEL=$(jq -r '[.power_and_fan.power_supplies[] | select(.part_number != "To Be Filled By O.E.M.") | .part_number] | .[0] // "N/A"' "$JSON_FILE")
[[ "$PSU_MODEL" == "N/A" ]] && warn "Failed to parse PSU model / no valid PSU part numbers found"
PSU_COUNT=$(jq '[.power_and_fan.power_supplies[] | select(.part_number != "To Be Filled By O.E.M.")] | length' "$JSON_FILE")
[[ "$PSU_COUNT" -eq 0 ]] && warn "Failed to parse PSU count or no PSUs found"

# Extract BIOS date and version more robustly
BIOS_DATE=$(echo "$BIOS_VERSION" | grep -oE '[0-9]{2}/[0-9]{2}/[0-9]{4}' || echo "N/A")
[[ "$BIOS_DATE" == "N/A" ]] && warn "Failed to parse BIOS date from: '$BIOS_VERSION'"
BIOS_VER=$(echo "$BIOS_VERSION" | grep -oE '[0-9]+\.[0-9]+' | tail -1 || echo "N/A")
[[ "$BIOS_VER" == "N/A" ]] && warn "Failed to parse BIOS version number from: '$BIOS_VERSION'"

# Format output like L10 report
write_output "Title: Firmware Version of L10 Server"
if [[ "$BUNDLE_VERSION" != "N/A" ]]; then
    write_output "Serial Number,BMC MAC Address,Model Number,CPLD version,BIOS Version,BMC Version,BKC Version"
    write_output "$SYSTEM_SN,$BMC_MAC,$SYSTEM_PN,$CPLD_VERSION,BIOS Date: $BIOS_DATE Ver $BIOS_VER,$BMC_VERSION,$BUNDLE_VERSION"
else
    write_output "Serial Number,BMC MAC Address,Model Number,CPLD version,BIOS Version,BMC Version"
    write_output "$SYSTEM_SN,$BMC_MAC,$SYSTEM_PN,$CPLD_VERSION,BIOS Date: $BIOS_DATE Ver $BIOS_VER,$BMC_VERSION"
fi
write_output ""

write_output "Title: Hardware Version of L10 Server"
write_output "Serial Number,CPU Model,CPU Count,MEM (GB),DIMM PN,DIMM Count"
write_output "$SYSTEM_SN,$CPU_MODEL,$CPU_COUNT,$MEM_GB,$DIMM_PN,$DIMM_COUNT"
write_output ""

write_output "Title: Detailed Hardware Version Per Node"
write_output "Item Name, Model Name, Qty"
write_output "System,$SYSTEM_PN,1"
write_output "Motherboard,$MB_PN,1"
write_output "Processor,$CPU_MODEL,$CPU_COUNT"
write_output "Memory,$DIMM_PN,$DIMM_COUNT"

# GPU Module and GPUs
if [[ "$GPU_COUNT" -gt 0 ]]; then
    write_output "GPU,$GPU_MODEL,$GPU_COUNT"
fi

# Storage details - aggregate by model
for model in "${!STORAGE_MODELS[@]}"; do
    write_output "Disk,$model,${STORAGE_MODELS[$model]}"
done | sort

# NICs (exclude RNDIS devices) - group by part number and count unique serial numbers
# This ensures NICs with the same serial number (dual-port cards) are counted once per model
declare -A NIC_MODELS
while IFS='|' read -r PART_NUMBER SERIAL_NUMBER; do
    # Use PART_NUMBER and SERIAL_NUMBER as a composite KEY to ensure uniqueness
    KEY="${PART_NUMBER}::${SERIAL_NUMBER}"
    if [[ -z "${NIC_MODELS[$KEY]}" ]]; then
        NIC_MODELS[$KEY]="$PART_NUMBER"
    fi
done < <(jq -r '.network_interfaces[] | select(.firmware != "RNDIS device") | "\(.part_number // "N/A")|\(.serial_number // "N/A")"' "$JSON_FILE")

# Count NICs per model
declare -A NIC_MODEL_COUNTS
for KEY in "${!NIC_MODELS[@]}"; do
    PART_NUMBER="${NIC_MODELS[$KEY]}"
    NIC_MODEL_COUNTS["$PART_NUMBER"]=$((${NIC_MODEL_COUNTS["$PART_NUMBER"]:-0} + 1))
done

# Output NIC cards grouped by model
for model in "${!NIC_MODEL_COUNTS[@]}"; do
    write_output "NIC card,$model,${NIC_MODEL_COUNTS[$model]}"
done | sort

# Power Supply
if [[ -n "$PSU_MODEL" ]] && [[ "$PSU_MODEL" != "N/A" ]] && [[ "$PSU_COUNT" -gt 0 ]]; then
    write_output "Power Supply,$PSU_MODEL,$PSU_COUNT"
fi
write_output ""

write_output "Title: Archive: all parts' Part Number (PN), Serial Number (SN) and Firmware (FW)"
write_output "Item, Information, Qty"
write_output "System PN,$SYSTEM_PN,1"
write_output "System SN,$SYSTEM_SN,1"
write_output "Chassis PN,$CHASSIS_PN,1"
write_output "Chassis SN,$CHASSIS_SN,1"
write_output "MB PN,$MB_PN,1"
write_output "MB SN,$MB_SN,1"

# Memory PN and SN with pipe separation - installed modules only, clean up part numbers
MEM_PNS=$(jq -r '[.memory.modules[] | select(.size | type == "string" and test("^[0-9]+ GB$")) | .part_number // "N/A" | gsub(" [A-Z]+$";"")] | join(" | ")' "$JSON_FILE")
[[ -z "$MEM_PNS" ]] && warn "Failed to parse memory module part numbers"
MEM_SNS=$(jq -r '[.memory.modules[] | select(.size | type == "string" and test("^[0-9]+ GB$")) | .serial_number // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$MEM_SNS" ]] && warn "Failed to parse memory module serial numbers"
write_output "Memory PN,$MEM_PNS,$DIMM_COUNT"
write_output "Memory SN,$MEM_SNS,$DIMM_COUNT"

# NIC PN, SN, FW, MAC details (exclude RNDIS devices, sorted by bus address)
NIC_PCIES=$(jq -r '[.network_interfaces[] | select(.firmware != "RNDIS device")] | sort_by(.bus // "") | [.[].bus // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$NIC_PCIES" ]] && warn "Failed to parse NIC PCIe bus addresses"
NIC_PNS=$(jq -r '[.network_interfaces[] | select(.firmware != "RNDIS device")] | sort_by(.bus // "") | [.[].part_number // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$NIC_PNS" ]] && warn "Failed to parse NIC part numbers"
NIC_SNS=$(jq -r '[.network_interfaces[] | select(.firmware != "RNDIS device")] | sort_by(.bus // "") | [.[].serial_number // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$NIC_SNS" ]] && warn "Failed to parse NIC serial numbers"
NIC_FWS=$(jq -r '[.network_interfaces[] | select(.firmware != "RNDIS device")] | sort_by(.bus // "") | [.[].firmware // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$NIC_FWS" ]] && warn "Failed to parse NIC firmware versions"
NIC_MACS=$(jq -r '[.network_interfaces[] | select(.firmware != "RNDIS device")] | sort_by(.bus // "") | [.[].mac // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$NIC_MACS" ]] && warn "Failed to parse NIC MAC addresses"

if [[ -n "$NIC_PCIES" ]] && [[ "$NIC_PCIES" != "N/A" ]]; then
    NIC_COUNT=$(echo "$NIC_PCIES" | awk -F'|' '{print NF}')
    write_output "NIC PCIe,$NIC_PCIES,$NIC_COUNT"
fi

if [[ -n "$NIC_PNS" ]] && [[ "$NIC_PNS" != "N/A" ]]; then
    NIC_COUNT=$(echo "$NIC_PNS" | awk -F'|' '{print NF}')
    write_output "NIC PN,$NIC_PNS,$NIC_COUNT"
fi

if [[ -n "$NIC_SNS" ]] && [[ "$NIC_SNS" != "N/A" ]]; then
    NIC_COUNT=$(echo "$NIC_SNS" | awk -F'|' '{print NF}')
    write_output "NIC SN,$NIC_SNS,$NIC_COUNT"
fi

if [[ -n "$NIC_FWS" ]] && [[ "$NIC_FWS" != "N/A" ]]; then
    NIC_COUNT=$(echo "$NIC_FWS" | awk -F'|' '{print NF}')
    write_output "NIC FW,$NIC_FWS,$NIC_COUNT"
fi

if [[ -n "$NIC_MACS" ]] && [[ "$NIC_MACS" != "N/A" ]]; then
    NIC_COUNT=$(echo "$NIC_MACS" | awk -F'|' '{print NF}')
    write_output "NIC MAC,$NIC_MACS,$NIC_COUNT"
fi

# GPU details - use correct field names ('name', 'serial', 'vbios')
GPU_PNS=$(jq -r '[.accelerators_gpu.devices[] | .name // "N/A" | gsub("NVIDIA NVIDIA"; "NVIDIA")] | join(" | ")' "$JSON_FILE")
[[ -z "$GPU_PNS" ]] && warn "Failed to parse GPU part numbers / names"
GPU_SNS=$(jq -r '[.accelerators_gpu.devices[] | .serial // "N/A" | gsub("^ +| +$"; "")] | join(" | ")' "$JSON_FILE")
[[ -z "$GPU_SNS" ]] && warn "Failed to parse GPU serial numbers"
GPU_FW=$(jq -r '[.accelerators_gpu.devices[] | .vbios // "N/A" | gsub("^ +| +$"; "")] | join(" | ")' "$JSON_FILE")
[[ -z "$GPU_FW" ]] && warn "Failed to parse GPU VBIOS versions"

if [[ -n "$GPU_PNS" ]] && [[ "$GPU_PNS" != "N/A" ]]; then
    GPU_COUNT=$(echo "$GPU_PNS" | awk -F'|' '{print NF}')
    write_output "GPU PN,$GPU_PNS,$GPU_COUNT"
    write_output "GPU SN,$GPU_SNS,$GPU_COUNT"
    write_output "GPU SW,$GPU_FW,$GPU_COUNT"
fi

# Storage PN, SN, FW - use correct field names ('serial' not 'SERIAL_NUMBER')
STORAGE_PN=$(jq -r '[.storage[] | .model // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$STORAGE_PN" ]] && warn "Failed to parse storage device models"
STORAGE_SN=$(jq -r '[.storage[] | .serial // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$STORAGE_SN" ]] && warn "Failed to parse storage device serial numbers"
STORAGE_FW=$(jq -r '[.storage[] | .firmware // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$STORAGE_FW" ]] && warn "Failed to parse storage device firmware versions"

if [[ -n "$STORAGE_PN" ]] && [[ "$STORAGE_PN" != "N/A" ]]; then
    STORAGE_COUNT=$(echo "$STORAGE_PN" | awk -F'|' '{print NF}')
    write_output "Disk PN,$STORAGE_PN,$STORAGE_COUNT"
    write_output "Disk SN,$STORAGE_SN,$STORAGE_COUNT"
    write_output "Disk FW,$STORAGE_FW,$STORAGE_COUNT"
fi

# PSU PN and SN details (keep all entries including placeholders for data integrity)
PSU_PNS=$(jq -r '[.power_and_fan.power_supplies[] | .part_number // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$PSU_PNS" ]] && warn "Failed to parse PSU part numbers"
PSU_SNS=$(jq -r '[.power_and_fan.power_supplies[] | .serial_number // "N/A"] | join(" | ")' "$JSON_FILE")
[[ -z "$PSU_SNS" ]] && warn "Failed to parse PSU serial numbers"

if [[ -n "$PSU_PNS" ]] && [[ "$PSU_PNS" != "N/A" ]]; then
    # Count only non-placeholder PSUs for the qty
    PSU_COUNT=$(jq '[.power_and_fan.power_supplies[] | select(.part_number != "To Be Filled By O.E.M.")] | length' "$JSON_FILE")
    write_output "PSU PN,$PSU_PNS,$PSU_COUNT"
fi

if [[ -n "$PSU_SNS" ]] && [[ "$PSU_SNS" != "N/A" ]]; then
    # Count only non-placeholder PSUs for the qty
    PSU_COUNT=$(jq '[.power_and_fan.power_supplies[] | select(.serial_number != "To Be Filled By O.E.M.")] | length' "$JSON_FILE")
    write_output "PSU SN,$PSU_SNS,$PSU_COUNT"
fi

# Final BOM data marker
write_output ""
write_output "BOM data collected"
