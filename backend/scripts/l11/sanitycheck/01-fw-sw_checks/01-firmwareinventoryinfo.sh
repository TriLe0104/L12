#!/bin/bash
#created by Samuel

# --- Argument Handling ---
FORCE_GOLDEN=0
while [[ "$1" == --* ]]; do
    case "$1" in
        --golden) FORCE_GOLDEN=1 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "Error: Incorrect number of arguments provided."
  echo "Usage: $0 [--golden] <log_dir> <SYS_SN> <bmc_ip> <bmc_pwd> [timestamp]"
  exit 1
fi

LOG_DIR="$1"
SYS_SN="$2"
BMC_IP="$3"
BMC_PWD="$4"
TIMESTAMP=${5:-$(date +%Y%m%d%H%M%S)}

# --- Path Setup ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME=$(basename "$0")
SCRIPT_NAME="${SCRIPT_NAME%.sh}"
DIR_NAME=$(basename "$SCRIPT_DIR")
# The TIMESTAMP variable is now taken from the arguments above
LOG_FOLDER="$LOG_DIR/$SYS_SN/101infosystem/${DIR_NAME}_${TIMESTAMP}"
mkdir -p "$LOG_FOLDER"

# --- Log File Definitions ---
LOG_PREFIX="${LOG_FOLDER}/${SCRIPT_NAME}"
SCOUT_FILE="${LOG_PREFIX}_${TIMESTAMP}.log"
DIF_FILE="${LOG_PREFIX}_${TIMESTAMP}.dif"
HST_FILE="${LOG_PREFIX}_${TIMESTAMP}.hst"
TMP_FILE="${LOG_PREFIX}_${TIMESTAMP}.tmp"
echo "${SCRIPT_NAME}" | tee -a $SCOUT_FILE
date | tee -a $SCOUT_FILE

echo "=================== start $SCRIPT_NAME $(hostname) $(date) ==================" | tee -a "$SCOUT_FILE"

# Initialize fail flag
FAIL_FLAG=0
GOLDEN_MISSING=0
FW_GOLDEN_CSV="$SCRIPT_DIR/../../data/fw_golden.csv"

if [ ! -f "$FW_GOLDEN_CSV" ]; then
  echo "Warning: Golden firmware file not found: $FW_GOLDEN_CSV" >&2
  echo "Capturing current state as new golden reference." >&2
  GOLDEN_MISSING=1
  # Create directory for golden file
  mkdir -p "$(dirname "$FW_GOLDEN_CSV")"
fi

if [[ $FORCE_GOLDEN -eq 1 ]]; then
  echo "Force-updating golden firmware reference (--golden flag)" | tee -a "$SCOUT_FILE"
  GOLDEN_MISSING=1
  mkdir -p "$(dirname "$FW_GOLDEN_CSV")"
fi

rm -f $TMP_FILE #initial setup
rm -f $HST_FILE
echo "############### processing getFirmwareInventory checkAssetInfo getGPUInfo  $SCRIPT_NAME ################" | tee -a $SCOUT_FILE

echo "Querying BMC Redfish API: $bmc_ip for firmware inventory" | tee -a "$SCOUT_FILE"

# Use Redfish API instead of SAA tool
# SAA tool equivalent command: saa -i $BMC_IP -u ADMIN -p "$BMC_PWD" -c getfirmwareinventoryinfo
REDFISH_URL="https://${BMC_IP}"
REDFISH_AUTH="-u ADMIN:${BMC_PWD}"
CURL_OPTS="-k -s"
# Get system serial number to verify BMC
SYSTEM_INFO=$(curl $CURL_OPTS $REDFISH_AUTH "${REDFISH_URL}/redfish/v1/Systems/1" 2>&1)
BMC_SN=$(echo "$SYSTEM_INFO" | jq -r '.SerialNumber // empty' 2>/dev/null)

if [[ -z "$BMC_SN" ]]; then
    echo "FAIL: cannot connect to BMC $BMC_IP with ADMIN:$BMC_PWD" | tee -a "$SCOUT_FILE"
    exit 1
fi

if [[ "$SYS_SN" != "TEST" && ( -z "$BMC_SN" || "$BMC_SN" != "$SYS_SN" ) ]]; then
    echo "FAIL: Serial number mismatch. Expected: $SYS_SN, Got: $BMC_SN." | tee -a "$SCOUT_FILE"
    exit 1
fi

# Get firmware inventory collection
FIRMWARE_LIST=$(curl $CURL_OPTS $REDFISH_AUTH "${REDFISH_URL}/redfish/v1/UpdateService/FirmwareInventory" 2>&1)

# Build firmware report in CSV format
FW_INVENTORY_CSV="Component,Version,Details"

# Extract member URLs using jq
MEMBER_URLS=$(echo "$FIRMWARE_LIST" | jq -r '.Members[]."@odata.id" // empty' 2>/dev/null)

# Create temporary directory for parallel processing
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Launch parallel curl requests
index=0
for member_url in $MEMBER_URLS; do
    echo "Querying: ${REDFISH_URL}${member_url}" | tee -a "$SCOUT_FILE"
    (
        member_data=$(curl $CURL_OPTS $REDFISH_AUTH "${REDFISH_URL}${member_url}" 2>&1)
        fw_name=$(echo "$member_data" | jq -r '.Name // empty' 2>/dev/null)
        fw_version=$(echo "$member_data" | jq -r '.Version // empty' 2>/dev/null)
        
        # Check for AMD OEM ComponentDetails (UBB or other)
        component_details=$(echo "$member_data" | jq -r '.Oem.AMD.VersionID.ComponentDetails // empty' 2>/dev/null)
        if [[ -n "$component_details" && "$component_details" != "null" ]]; then
            fw_version="${fw_version},${component_details}"
        fi
        
        # Handle null/empty versions
        if [[ -z "$fw_version" || "$fw_version" == "null" ]]; then
            fw_version="null"
        fi
        
        if [[ -n "$fw_name" && "$fw_name" != "null" ]]; then
            echo "${fw_name},${fw_version}"
        fi
    ) > "$TEMP_DIR/fw_$(printf "%03d" $index)" &
    ((index++))
done

# Wait for all parallel jobs to complete
wait

# Read results in order and append to output
for ((i=0; i<index; i++)); do
    if [[ -f "$TEMP_DIR/fw_$(printf "%03d" $i)" ]]; then
        content=$(cat "$TEMP_DIR/fw_$(printf "%03d" $i)")
        if [[ -n "$content" ]]; then
            FW_INVENTORY_CSV="${FW_INVENTORY_CSV}
${content}"
        fi
    fi
done

# Query additional NIC information from PCIeDevices endpoint
echo "Querying PCIe NIC information..." | tee -a "$SCOUT_FILE"
echo "Querying: ${REDFISH_URL}/redfish/v1/Chassis/1/PCIeDevices" | tee -a "$SCOUT_FILE"
PCIE_DEVICES=$(curl $CURL_OPTS $REDFISH_AUTH "${REDFISH_URL}/redfish/v1/Chassis/1/PCIeDevices" 2>&1)
PCIE_NICS=$(echo "$PCIE_DEVICES" | jq -r '.Members[]."@odata.id" | select(contains("NIC"))' 2>/dev/null)

NIC_INDEX=0
for nic_url in $PCIE_NICS; do
    echo "Querying: ${REDFISH_URL}${nic_url}" | tee -a "$SCOUT_FILE"
    (
        nic_data=$(curl $CURL_OPTS $REDFISH_AUTH "${REDFISH_URL}${nic_url}" 2>&1)
        nic_model=$(echo "$nic_data" | jq -r '.Model // empty' 2>/dev/null)
        nic_fw=$(echo "$nic_data" | jq -r '.FirmwareVersion // empty' 2>/dev/null)
        nic_state=$(echo "$nic_data" | jq -r '.Status.State // empty' 2>/dev/null)
        nic_id=$(basename "$nic_url")
        
        # Only add NICs not already in FirmwareInventory
        if [[ -n "$nic_model" && "$nic_model" != "null" && "$nic_state" == "Enabled" ]]; then
            # Check if this NIC was already captured from FirmwareInventory
            if ! grep -q "^${nic_id}," "$HST_FILE" 2>/dev/null; then
                nic_label="${nic_id} ${nic_model}"
                if [[ -z "$nic_fw" || "$nic_fw" == "null" ]]; then
                    nic_fw="null"
                fi
                echo "${nic_label},${nic_fw}"
            fi
        fi
    ) > "$TEMP_DIR/nic_$(printf "%03d" $NIC_INDEX)" &
    ((NIC_INDEX++))
done

wait

# Read NIC results in order and append to output
for ((i=0; i<NIC_INDEX; i++)); do
    if [[ -f "$TEMP_DIR/nic_$(printf "%03d" $i)" ]]; then
        content=$(cat "$TEMP_DIR/nic_$(printf "%03d" $i)")
        if [[ -n "$content" ]]; then
            FW_INVENTORY_CSV="${FW_INVENTORY_CSV}
${content}"
        fi
    fi
done

# Query GPU information from Supermicro OEM endpoint
echo "Querying GPU firmware information..." | tee -a "$SCOUT_FILE"
echo "Querying: ${REDFISH_URL}/restapi/Supermicro/GPUInfo" | tee -a "$SCOUT_FILE"
GPU_INFO=$(curl $CURL_OPTS $REDFISH_AUTH "${REDFISH_URL}/restapi/Supermicro/GPUInfo" 2>&1)
GPU_COUNT=$(echo "$GPU_INFO" | jq -r '.GPUInfo | length' 2>/dev/null)

if [[ "$GPU_COUNT" =~ ^[0-9]+$ && "$GPU_COUNT" -gt 0 ]]; then
    # Extract all GPU data in one pass and process in parallel
    for ((i=0; i<GPU_COUNT; i++)); do
        (
            gpu_location=$(echo "$GPU_INFO" | jq -r ".GPUInfo[$i].Location // empty" 2>/dev/null)
            gpu_model=$(echo "$GPU_INFO" | jq -r ".GPUInfo[$i].Model // empty" 2>/dev/null)
            gpu_fw_ver=$(echo "$GPU_INFO" | jq -r ".GPUInfo[$i].FWVer // empty" 2>/dev/null)
            
            if [[ -n "$gpu_location" && -n "$gpu_model" ]]; then
                gpu_name="${gpu_location}_${gpu_model}"
                if [[ -z "$gpu_fw_ver" || "$gpu_fw_ver" == "null" ]]; then
                    gpu_fw_ver="null"
                fi
                echo "${gpu_name},${gpu_fw_ver}"
            fi
        ) > "$TEMP_DIR/gpu_$(printf "%03d" $i)" &
    done
    
    wait
    
    # Read GPU results in order and append to output
    for ((i=0; i<GPU_COUNT; i++)); do
        if [[ -f "$TEMP_DIR/gpu_$(printf "%03d" $i)" ]]; then
            content=$(cat "$TEMP_DIR/gpu_$(printf "%03d" $i)")
            if [[ -n "$content" ]]; then
                FW_INVENTORY_CSV="${FW_INVENTORY_CSV}
${content}"
            fi
        fi
    done
    
    echo "Added $GPU_COUNT GPU firmware entries" | tee -a "$SCOUT_FILE"
else
    echo "No GPU information available or query failed" | tee -a "$SCOUT_FILE"
fi

# Query HGX baseboard model
echo "Querying HGX baseboard information..." | tee -a "$SCOUT_FILE"
echo "Querying: ${REDFISH_URL}/redfish/v1/Chassis/UBB" | tee -a "$SCOUT_FILE"
UBB_INFO=$(curl $CURL_OPTS $REDFISH_AUTH "${REDFISH_URL}/redfish/v1/Chassis/UBB" 2>&1)
UBB_MODEL=$(echo "$UBB_INFO" | jq -r '.Model // empty' 2>/dev/null)

if [[ -n "$UBB_MODEL" && "$UBB_MODEL" != "null" ]]; then
    FW_INVENTORY_CSV="${FW_INVENTORY_CSV}
HGX_Baseboard_Model,${UBB_MODEL}"
    echo "Added HGX baseboard information" | tee -a "$SCOUT_FILE"
fi

echo "$FW_INVENTORY_CSV" | tee -a "$SCOUT_FILE" "$HST_FILE"
sleep 1

if [[ $GOLDEN_MISSING -eq 1 ]]; then
    echo "############### saving as golden firmware reference ################" | tee -a "$SCOUT_FILE"
    cp "$HST_FILE" "$FW_GOLDEN_CSV"
    echo "Golden firmware saved to: $FW_GOLDEN_CSV" | tee -a "$SCOUT_FILE"
    echo "Firmware capture completed successfully." | tee -a "$SCOUT_FILE"
else
    echo "############### comparing firmware versions $SCRIPT_NAME ################" | tee -a "$SCOUT_FILE"
    echo "Golden file: $FW_GOLDEN_CSV" | tee -a "$SCOUT_FILE"
    echo "Actual file: $HST_FILE" | tee -a "$SCOUT_FILE"

    # Parse CSV files and compare by component (first column)
    declare -A golden_components
    declare -A actual_components

    # Read golden file (skip header) - handle 2 or 3 column CSV
    while read -r line; do
        # Skip empty lines and header
        [[ -z "$line" ]] && continue
        [[ "$line" =~ ^Component ]] && continue
        
        # Parse CSV manually to handle embedded commas properly
        # Split on first comma for component name
        col1="${line%%,*}"
        remainder="${line#*,}"
        
        # Clean component name aggressively - remove ALL non-printable characters
        col1="$(echo "$col1" | tr -cd '[:print:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        
        # Skip if empty after cleaning
        [[ -z "$col1" ]] && continue
        
        # Store the remainder as the value (version and optional details)
        golden_components["$col1"]="$remainder"
    done < "$FW_GOLDEN_CSV"

    # Read actual file (skip header) - handle 2 or 3 column CSV
    while read -r line; do
        # Skip empty lines and header
        [[ -z "$line" ]] && continue
        [[ "$line" =~ ^Component ]] && continue
        
        # Parse CSV manually to handle embedded commas properly
        # Split on first comma for component name
        col1="${line%%,*}"
        remainder="${line#*,}"
        
        # Clean component name aggressively - remove ALL non-printable characters
        col1="$(echo "$col1" | tr -cd '[:print:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        
        # Skip if empty after cleaning
        [[ -z "$col1" ]] && continue
        
        # Store the remainder as the value (version and optional details)
        actual_components["$col1"]="$remainder"
    done < "$HST_FILE"

    # Output differences to stderr and count them
    DIFF_COUNT=0

    # Check for version mismatches first, then missing/extra
    for component in "${!golden_components[@]}"; do
        golden_value="${golden_components[$component]}"
        
        if [[ -v "actual_components[$component]" ]]; then
            # Component exists in both - check if values match
            actual_value="${actual_components[$component]}"
            if [[ "$golden_value" != "$actual_value" ]]; then
                printf "MISMATCH: %s | EXP: %s | FOUND: %s\n" "$component" "$golden_value" "$actual_value" >&2
                ((DIFF_COUNT++))
            fi
        else
            # Component missing from actual
            printf "MISSING: %s | %s\n" "$component" "$golden_value" >&2
            ((DIFF_COUNT++))
        fi
    done

    # Check for extra components (in actual but not in golden)
    for component in "${!actual_components[@]}"; do
        if [[ ! -v "golden_components[$component]" ]]; then
            printf "EXTRA: %s | %s\n" "$component" "${actual_components[$component]}" >&2
            ((DIFF_COUNT++))
        fi
    done

    if [[ $DIFF_COUNT -gt 0 ]]; then
        printf "Total firmware differences: %d\n" "$DIFF_COUNT" >&2
        echo "getFirmwareInventoryInfo version check FAIL : $SYS_SN $BMC_IP $BMC_PWD" | tee -a "$SCOUT_FILE"
        FAIL_FLAG=1
    else
        echo "getFirmwareInventoryInfo version check PASS $SYS_SN $BMC_IP $BMC_PWD" | tee -a "$SCOUT_FILE"
    fi
fi


echo "================================================================" | tee -a $SCOUT_FILE
echo "Start time epoch: ${TIMESTAMP}" 
echo "Start time: $(date -d "${TIMESTAMP:0:8} ${TIMESTAMP:8:2}:${TIMESTAMP:10:2}:${TIMESTAMP:12:2}" +"%b %d %H:%M:%S %Y" 2>/dev/null)"
echo "End time: $(date)"

if [[ $GOLDEN_MISSING -eq 1 ]]; then
  echo "FINAL RESULT $SCRIPT_NAME : GOLDEN_NOT_FOUND (capture only)" | tee -a "$SCOUT_FILE"
  echo "logfile: $SCOUT_FILE"
  echo "firmware ver host: $HST_FILE"
  echo "${SCRIPT_NAME}" | tee -a $SCOUT_FILE
  date | tee -a $SCOUT_FILE
  echo "########################## end $SCRIPT_NAME ########################################" | tee -a $SCOUT_FILE
  exit 82
fi

if [[ $FAIL_FLAG -eq 0 ]]; then
  echo "FINAL RESULT $SCRIPT_NAME : PASS" | tee -a "$SCOUT_FILE"
else
  echo "FINAL RESULT $SCRIPT_NAME : FAIL" | tee -a "$SCOUT_FILE"
fi

echo "logfile: $SCOUT_FILE"
echo "firmware ver diff: $DIF_FILE"
echo "firmware ver host: $HST_FILE"
echo "firmware gold file: $FW_GOLDEN_CSV"

echo "${SCRIPT_NAME}" | tee -a $SCOUT_FILE
date | tee -a $SCOUT_FILE
echo "########################## end $SCRIPT_NAME ########################################" | tee -a $SCOUT_FILE

exit $FAIL_FLAG

