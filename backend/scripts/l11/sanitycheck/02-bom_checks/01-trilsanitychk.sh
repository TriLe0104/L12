#!/bin/bash

BASE_DIR="${AIHPC_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

export PATH=$PATH:/usr/sbin:/sbin:/opt/rocm/bin

BMC_PWD=""
BMC_IP="${BMC_IP:-}"
SMC_USER_ARG="${SMC_USER:-ADMIN}"
BOM_FILE=""
REMOTE_HOST=""
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_PASS="${REMOTE_PASS:-test}"
EXPORT_PATH=""
UNKNOWN="Unknown"

# Parse arguments with flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      REMOTE_HOST="$2"
      shift 2
      ;;
    --bmc-pwd)
      BMC_PWD="$2"
      shift 2
      ;;
    --bmc-ip)
      BMC_IP="$2"
      shift 2
      ;;
    --bmc-user)
      SMC_USER_ARG="$2"
      shift 2
      ;;
    --export)
      # Check if next argument is a path (not a flag)
      if [[ -n "$2" ]] && [[ "$2" != -* ]]; then
        EXPORT_PATH="$2"
        shift 2
      else
        shift
      fi
      ;;
    --compare-bom)
      BOM_FILE="$2"
      if [[ -z "$BOM_FILE" ]]; then
        echo "Error: --compare-bom requires a golden BOM JSON file path." >&2
        echo "Usage: $0 [--host <ip>] [--bmc-ip <ip>] [--bmc-user <user>] [--bmc-pwd <password>] [--export <path>] [--compare-bom <golden.json>]" >&2
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "Warning: Unknown argument '$1' ignored." >&2
      shift
      ;;
  esac
done

# -------------------------------------------------------------------
# ----- INSTALL DEPENDENCIES (runs on target machine) ---------------
# -------------------------------------------------------------------
install_dependencies() {
  echo "Checking and installing required dependencies..." >&2
  
  local needs_install=false
  
  # Check if jq is missing
  if ! command -v jq &>/dev/null; then
    needs_install=true
  fi
  
  # Check if hwloc/lstopo is missing
  if [[ ! -f /usr/bin/lstopo ]]; then
    needs_install=true
  fi
  
  # Only run apt update if something needs to be installed
  if [[ "$needs_install" == true ]]; then
    echo "Running apt update..." >&2
    apt-get update -y >/dev/null 2>&1 || echo "Warning: apt-get update failed" >&2
    
    # Install jq (required for JSON operations)
    if ! command -v jq &>/dev/null; then
      echo "Installing jq..." >&2
      apt-get install -y jq >/dev/null 2>&1 || echo "Warning: Failed to install jq" >&2
    fi
    
    # Install hwloc (provides lstopo for topology diagrams)
    if [[ ! -f /usr/bin/lstopo ]]; then
      echo "Installing hwloc..." >&2
      apt-get install -y hwloc >/dev/null 2>&1 || echo "Warning: Failed to install hwloc" >&2
    fi
  else
    echo "All dependencies already installed, skipping apt update." >&2
  fi
  
  echo "Dependency check complete." >&2
  echo "" >&2
}


WIDTH=80

RED=$'\e[31m'
YELLOW=$'\e[33m'
WHITE=$'\e[37m'
CYAN=$'\e[36m'
RESET=$'\e[0m'

# -------------------------------------------------------------------
# ----- BOM CHECK FUNCTION (defined early for remote execution) -----
# -------------------------------------------------------------------
perform_bom_check() {
  local ref_file="$1"
  local sys_file="$2"  # Optional: if provided, compare two JSON files instead of live system
  
  if [[ ! -f "$ref_file" ]]; then echo "Error: Golden BOM file not found: '$ref_file'" >&2; exit 82; fi
  if ! command -v jq &>/dev/null; then echo "Error: 'jq' required." >&2; exit 1; fi

  local comparison_label
  local _tmp_sys_file=""
  local diff_count=0

  if [[ -n "$sys_file" ]]; then
    # Compare two JSON files
    if [[ ! -f "$sys_file" ]]; then echo "Error: System JSON '$sys_file' not found." >&2; exit 1; fi
    echo "Comparing reference JSON against: $sys_file"
    comparison_label="System (File)"
  else
    # Write live system state to a temp file — avoids storing large JSON in bash variables
    echo "Gathering current system state..."
    _tmp_sys_file=$(mktemp /tmp/bom_sys_XXXXXX.json)
    print_report_json > "$_tmp_sys_file"
    sys_file="$_tmp_sys_file"
    comparison_label="System (Current)"
  fi

  # --- Table Configuration ---
  local W_L=28; local W_D=48; local W_S=8

  # Helper for repeating characters (using head -c for compatibility)
  get_line() { head -c $1 < /dev/zero | tr '\0' "$2"; }
  
  # Construct Divider: +------+------+------+------+
  local DIVIDER="+$(get_line $((W_L+2)) '-')+$(get_line $((W_D+2)) '-')+$(get_line $((W_D+2)) '-')+$(get_line $((W_S+2)) '-')+"

  # Row Printer: Manually calculates padding to guarantee alignment
  print_row_robust() {
    local lbl="$1"; local ref="$2"; local sys="$3"; local stat="$4"
    local c_ref="$5"; local c_sys="$6"; local c_stat="$7"

    # Truncate content to max column width to prevent wrapping
    local ref_trunc="${ref:0:$W_D}"
    local sys_trunc="${sys:0:$W_D}"
    
    # Calculate padding spaces
    local pad_l=$((W_L - ${#lbl}))
    local pad_r=$((W_D - ${#ref_trunc}))
    local pad_s=$((W_D - ${#sys_trunc}))
    local pad_st=$((W_S - ${#stat}))

    # Print Line: | Label | Ref | Sys | Status |
    printf "| %s%s | %b%s%b%s | %b%s%b%s | %b%s%b%s |\n" \
      "$lbl" "$(get_line $pad_l ' ')" \
      "$c_ref" "$ref_trunc" "$RESET" "$(get_line $pad_r ' ')" \
      "$c_sys" "$sys_trunc" "$RESET" "$(get_line $pad_s ' ')" \
      "$c_stat" "$stat" "$RESET" "$(get_line $pad_st ' ')"
  }

  # --- Comparators ---

  compare_row() {
    local label="$1"; local path="$2"
    local val_ref=$(jq -r "$path // \"N/A\"" "$ref_file")
    local val_sys=$(jq -r "$path // \"N/A\"" "$sys_file")
    if [[ "$val_ref" == "$val_sys" ]]; then print_row_robust "$label" "$val_ref" "$val_sys" "OK" "$CYAN" "$CYAN" "$YELLOW"
    else print_row_robust "$label" "$val_ref" "$val_sys" "DIFF" "$WHITE" "$RED" "$RED"; ((diff_count++)); echo "DIFF: $label | ref: $val_ref | sys: $val_sys" >&2; fi
  }

  compare_count() {
    local label="$1"; local path="$2"
    local val_ref=$(jq -r "$path | length" "$ref_file")
    local val_sys=$(jq -r "$path | length" "$sys_file")
    if [[ "$val_ref" == "$val_sys" ]]; then print_row_robust "$label (Qty)" "$val_ref" "$val_sys" "OK" "$CYAN" "$CYAN" "$YELLOW"
    else print_row_robust "$label (Qty)" "$val_ref" "$val_sys" "DIFF" "$WHITE" "$RED" "$RED"; ((diff_count++)); echo "DIFF: $label (Qty) | ref: $val_ref | sys: $val_sys" >&2; fi
  }

  compare_unique() {
    local label="$1"; local path="$2"; local key="$3"
    # Extract field, handle nulls, sort unique, join
    local q="$path | map(.$key // \"N/A\") | unique | join(\", \")"
    local val_ref=$(jq -r "$q" "$ref_file")
    local val_sys=$(jq -r "$q" "$sys_file")

    [[ -z "$val_ref" ]] && val_ref="N/A"
    [[ -z "$val_sys" ]] && val_sys="N/A"

    if [[ "$val_ref" == "$val_sys" ]]; then print_row_robust "$label" "$val_ref" "$val_sys" "OK" "$CYAN" "$CYAN" "$YELLOW"
    else print_row_robust "$label" "$val_ref" "$val_sys" "DIFF" "$WHITE" "$RED" "$RED"; ((diff_count++)); echo "DIFF: $label | ref: $val_ref | sys: $val_sys" >&2; fi
  }

  # --- Execution ---
  
  echo "$DIVIDER"
  printf "| %-${W_L}s | %-${W_D}s | %-${W_D}s | %-${W_S}s |\n" "Component" "Reference (JSON)" "$comparison_label" "Status"
  echo "$DIVIDER"

  # 1. Software & FW
  compare_row "OS Version" ".system.os_version"
  compare_row "Kernel Version" ".system.kernel_version"
  compare_row "BIOS Version" ".firmware.bios_version"
  compare_row "BMC Version" ".firmware.bmc_version"
  compare_row "CPLD Version" ".firmware.cpld_version"
  compare_row "Bundle Version" ".firmware.bkc_version"
  compare_row "GPU VBIOS (Global)" ".accelerators_gpu.global_vbios"
  echo "$DIVIDER"

  # 2. Hardware Identity
  compare_row "System Model" ".system.system_pn"
  compare_row "Motherboard PN" ".system.motherboard.part_number"
  echo "$DIVIDER"

  # 3. TPM
  compare_row "TPM Model" ".tpm.model"
  compare_row "TPM Revision" ".tpm.revision"
  echo "$DIVIDER"

  # 4. CPU & Memory
  compare_row "CPU Model" ".cpu.info.model"
  compare_row "Total Memory" ".memory.summary"
  compare_count "DIMM Count" ".memory.modules"
  compare_unique "DIMM Part#" ".memory.modules" "part_number"
  echo "$DIVIDER"

  # 5. GPUs
  compare_count "GPU Count" ".accelerators_gpu.devices"
  compare_row "GPU Model" ".accelerators_gpu.devices[0].name"
  echo "$DIVIDER"

  # 6. NICs
  compare_count "NIC Count" ".network_interfaces"
  compare_unique "NIC Firmware" ".network_interfaces" "firmware"
  compare_unique "NIC Part#" ".network_interfaces" "part_number"
  echo "$DIVIDER"

  # 7. Storage
  compare_count "Drive Count" ".storage"
  compare_unique "Drive Model(s)" ".storage" "model"
  compare_unique "Drive Firmware" ".storage" "firmware"
  echo "$DIVIDER"

  # Clean up temp file used for live system comparison
  [[ -n "$_tmp_sys_file" ]] && rm -f "$_tmp_sys_file"
  return $((diff_count > 0 ? 1 : 0))
}

# Install dependencies on the target machine (local or will be called on remote)
if [[ -z "$REMOTE_HOST" ]]; then
  # Only install if running locally; remote execution will handle its own install
  install_dependencies
fi

# Remote execution logic
if [[ -n "$REMOTE_HOST" ]]; then
  echo "Remote execution mode: Connecting to $REMOTE_HOST"
  
  # Check if sshpass is installed
  if ! command -v sshpass &> /dev/null; then
    echo "Error: sshpass is not installed. Please install it first." >&2
    exit 1
  fi
  
  # Copy script to remote host
  SCRIPT_NAME=$(basename "$0")
  REMOTE_SCRIPT="/tmp/${SCRIPT_NAME}"
  
  echo "Copying script to ${REMOTE_HOST}:${REMOTE_SCRIPT}..."
  sshpass -p "$REMOTE_PASS" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$0" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_SCRIPT}" 2> >(grep -v "Permanently added" >&2)
  
  if [[ $? -ne 0 ]]; then
    echo "Error: Failed to copy script to remote host." >&2
    exit 1
  fi
  
  # Make script executable on remote host
  sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "${REMOTE_USER}@${REMOTE_HOST}" "chmod +x ${REMOTE_SCRIPT}" 2>/dev/null
  
  # Build remote command with remaining arguments
  REMOTE_CMD="${REMOTE_SCRIPT}"
  if [[ -n "$BMC_IP" ]]; then
    REMOTE_CMD="$REMOTE_CMD --bmc-ip \"$BMC_IP\""
  fi
  if [[ -n "$SMC_USER_ARG" ]]; then
    REMOTE_CMD="$REMOTE_CMD --bmc-user \"$SMC_USER_ARG\""
  fi
  if [[ -n "$BMC_PWD" ]]; then
    REMOTE_CMD="$REMOTE_CMD --bmc-pwd \"$BMC_PWD\""
  fi
  # Note: --compare-bom is NOT forwarded to the remote script.
  # The BOM check runs locally after the JSON is retrieved (see below).

  echo "Executing script on ${REMOTE_HOST}..."

  # Run remote script; human-readable output streams directly to terminal (stdout)
  # Capture stderr separately to extract the saved JSON/PNG file paths
  TEMP_STDERR=$(mktemp)

  sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "${REMOTE_USER}@${REMOTE_HOST}" "$REMOTE_CMD" 2>"$TEMP_STDERR"
  SSH_EXIT=$?

  # Always print captured stderr to terminal (stdout so it doesn't pollute bom_stderr)
  [[ -s "$TEMP_STDERR" ]] && cat "$TEMP_STDERR"

  if [[ $SSH_EXIT -ne 0 ]]; then
    echo "Error: Remote execution failed (exit $SSH_EXIT)." >&2
    rm -f "$TEMP_STDERR"
    exit 1
  fi

  # Extract remote JSON and PNG paths from stderr messages
  REMOTE_JSON_PATH=$(grep -oP 'JSON report saved to: \K\S+' "$TEMP_STDERR" | head -1)
  REMOTE_PNG_PATH=$(grep -oP '✓ PCIe topology diagram saved to: \K\S+' "$TEMP_STDERR" | head -1)
  rm -f "$TEMP_STDERR"

  # Determine local output path
  determine_output_path() {
    local remote_path="$1"
    local fname
    fname=$(basename "$remote_path")
    if [[ -n "$EXPORT_PATH" ]]; then
      if [[ -d "$EXPORT_PATH" ]]; then
        echo "${EXPORT_PATH}/${fname}"
      else
        echo "$EXPORT_PATH"
      fi
    else
      echo "$fname"
    fi
  }

  # SCP the JSON file from remote
  if [[ -n "$REMOTE_JSON_PATH" ]]; then
    OUTPUT_FILE=$(determine_output_path "$REMOTE_JSON_PATH")
    echo "Retrieving JSON report from remote host..."
    sshpass -p "$REMOTE_PASS" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_JSON_PATH}" "$OUTPUT_FILE" 2>/dev/null
    if [[ $? -eq 0 ]]; then
      echo "Remote JSON saved to: $OUTPUT_FILE"
    else
      echo "Warning: Failed to retrieve JSON from remote host" >&2
    fi
  else
    echo "Warning: Could not determine remote JSON path; JSON not retrieved." >&2
  fi

  # SCP the topology PNG from remote
  if [[ -n "$REMOTE_PNG_PATH" && -n "$OUTPUT_FILE" ]]; then
    LOCAL_PNG="${OUTPUT_FILE%.json}_topology.png"
    echo "Retrieving topology diagram from remote host..."
    sshpass -p "$REMOTE_PASS" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PNG_PATH}" "$LOCAL_PNG" 2>/dev/null
    if [[ $? -eq 0 ]]; then
      echo "✓ Topology diagram saved to: $LOCAL_PNG"
    else
      echo "Warning: Failed to retrieve topology diagram from remote host" >&2
    fi
  fi

  # If --compare-bom was given, run BOM comparison locally against the retrieved JSON
  bom_rc=0
  if [[ -n "$BOM_FILE" ]]; then
    if [[ -n "$OUTPUT_FILE" && -f "$OUTPUT_FILE" ]]; then
      echo "Comparing remote system against reference: $BOM_FILE"
      perform_bom_check "$BOM_FILE" "$OUTPUT_FILE"
      bom_rc=$?
    else
      echo "Error: Cannot run BOM check - JSON file not retrieved." >&2
      exit 1
    fi
  fi
  
  # Cleanup remote script
  sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "${REMOTE_USER}@${REMOTE_HOST}" "rm -f ${REMOTE_SCRIPT}" 2>/dev/null
  
  exit $bom_rc
fi

print_border_line() {
  head -c $WIDTH < /dev/zero | tr '\0' '-'
}

print_divider() {
  printf "+%s+\n" "$(print_border_line)"
}

print_section_header() {
  print_line "  ${YELLOW}${1}${RESET}"
  print_divider
}

print_line() {
  local input="$1"
  while IFS= read -r line; do
    printf "%b\n" "$line"
  done <<< "$input"
}

print_centered_line() {
  local line="$1"
  local clean_line
  clean_line=$(echo -e "$line" | sed -r 's/\x1B\[[0-9;]*[mK]//g')
  local left_pad=$(( (WIDTH - ${#clean_line}) / 2 ))
  printf "%*s%b\n" "$left_pad" "" "$line"
}

print_label_value_aligned() {
  local label="$1"
  local value="$2"
  local label_width=20
  local indent=$((label_width + 2))

  local first=1
  while IFS= read -r line; do
    line=$(echo "$line" | sed 's/^[ \t]*//;s/[ \t]*$//')
    if [[ $first -eq 1 ]]; then
      printf "  %-*s: %s\n" $label_width "$label" "$line"
      first=0
    else
      printf "  %*s  %s\n" $label_width "" "$line"
    fi
  done <<< "$value"
}


# ----- System Info Functions -----
get_hostname() { hostname; }
get_os_version() { lsb_release -ds 2>/dev/null || grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2- | tr -d '\"' || echo "$UNKNOWN"; }
get_kernel_version() { uname -r; }

# ----- Network Info (OS & BMC) -----
get_ssh_ip() { hostname -I | awk '{print $1}'; }
get_ssh_mac() {
  local iface
  iface=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}')
  [[ -n "$iface" ]] && cat /sys/class/net/"$iface"/address 2>/dev/null || echo "$UNKNOWN"
}
get_ssh_interface() { ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}'; }
get_ssh_ip_source() {
  local iface
  iface=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}')
  local conf_file="/etc/netplan/*.yaml"
  if grep -q "dhcp4: true" $conf_file 2>/dev/null; then echo "DHCP"; else echo "Static"; fi
}
get_ssh_subnet() {
  local iface
  iface=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}')
  if [[ -n "$iface" ]]; then
    ip -o -f inet addr show "$iface" | awk '{print $4}' | cut -d/ -f2 | \
      awk '{mask=$1;for(i=0;i<4;i++){if(mask>=8){printf"255";mask-=8}else if(mask>0){printf"%d",(256-2^(8-mask));mask=0}else{printf"0"}if(i<3)printf"."}printf"\n"}'
  else
    echo "$UNKNOWN"
  fi
}
get_ssh_gateway() { ip route | awk '/default/ {print $3}' || echo "$UNKNOWN"; }
get_bmc_ip_source() { timeout 10 ipmitool lan print 1 2>/dev/null | awk -F: '/IP Address Source/ {print $2}' | xargs; }
get_bmc_subnet() { timeout 10 ipmitool lan print 1 2>/dev/null | awk -F: '/Subnet Mask/ {print $2}' | xargs || echo "$UNKNOWN"; }
get_bmc_gateway() { timeout 10 ipmitool lan print 1 2>/dev/null | awk -F: '/Default Gateway IP/ {print $2}' | xargs; }
get_bmc_ip() { local ip; ip=$(get_bmc_ip_local); echo "${ip:-$UNKNOWN}"; }
get_bmc_mac() { timeout 10 ipmitool lan print 1 2>/dev/null | grep 'MAC Address' | awk -F: '{print $2 ":" $3 ":" $4 ":" $5 ":" $6 ":" $7}' | xargs || echo "$UNKNOWN"; }

# ----- DMI (MB/Chassis/System) -----
get_system_pn() { dmidecode -s system-product-name 2>/dev/null || echo "$UNKNOWN"; }
get_system_sn() { dmidecode -s system-serial-number 2>/dev/null || echo "$UNKNOWN"; }
get_mb_pn() { dmidecode -s baseboard-product-name 2>/dev/null || echo "$UNKNOWN"; }
get_mb_sn() { dmidecode -s baseboard-serial-number 2>/dev/null || echo "$UNKNOWN"; }
get_chassis_sn() { dmidecode -s chassis-serial-number 2>/dev/null || echo "$UNKNOWN"; }

# ----- Firmware -----
get_bmc_ip_local() {
  if [[ -n "$BMC_IP" && "$BMC_IP" != "$UNKNOWN" ]]; then
    echo "$BMC_IP"
    return
  fi
  timeout 10 ipmitool lan print 1 2>/dev/null | awk -F: '/IP Address[[:space:]]*:/ && $1 !~ /Source/ {print $2}' | xargs
}

get_bios_version() {
  local bios_ver
  local bios_date
  bios_ver=$(dmidecode -s bios-version 2>/dev/null)
  bios_date=$(dmidecode -s bios-release-date 2>/dev/null)
  echo "$bios_ver (Date: $bios_date)" | sed 's/^[ \t]*//;s/[ \t]*$//'
}

# Shared function to get Redfish firmware inventory once
get_redfish_firmware_inventory() {
  local bmc_ip
  bmc_ip=$(get_bmc_ip_local)
  if [[ -z "$bmc_ip" || "$bmc_ip" == "$UNKNOWN" ]]; then echo ""; return 1; fi
  
  local REDFISH_URL="https://${bmc_ip}"
  local REDFISH_AUTH="-u ${SMC_USER_ARG}:${BMC_PWD}"
  local CURL_OPTS="-k -s --max-time 10"
  
  curl $CURL_OPTS $REDFISH_AUTH "${REDFISH_URL}/redfish/v1/UpdateService/FirmwareInventory" 2>/dev/null
}

# Extract specific firmware version from inventory
# Args: <inventory_json> <jq_filter> [jq_path]  (jq_path defaults to .Details // .Version)
get_firmware_version_from_inventory() {
  local inventory="$1"
  local filter="$2"
  local jq_path="${3:-.Version}"
  local bmc_ip
  bmc_ip=$(get_bmc_ip_local)
  
  if [[ -z "$inventory" || -z "$bmc_ip" ]]; then echo "$UNKNOWN"; return; fi
  
  local REDFISH_URL="https://${bmc_ip}"
  local REDFISH_AUTH="-u ${SMC_USER_ARG}:${BMC_PWD}"
  local CURL_OPTS="-k -s --max-time 10"
  
  local fw_url=$(echo "$inventory" | jq -r ".Members[].\"@odata.id\" | select($filter)" 2>/dev/null | head -n1)
  
  if [[ -n "$fw_url" ]]; then
    curl $CURL_OPTS $REDFISH_AUTH "${REDFISH_URL}${fw_url}" 2>/dev/null | jq -r "(${jq_path}) // \"$UNKNOWN\"" 2>/dev/null
  else
    echo "$UNKNOWN"
  fi
}

# Firmware inventory is fetched once and cached to avoid redundant Redfish HTTP calls
_FW_INV_CACHE=""
_get_fw_inv_cached() {
  if [[ -z "$_FW_INV_CACHE" ]]; then
    local bmc_ip
    bmc_ip=$(get_bmc_ip_local)
    if [[ -z "$bmc_ip" || "$bmc_ip" == "$UNKNOWN" ]]; then
      _FW_INV_CACHE="__NO_BMC_IP__"
    else
      _FW_INV_CACHE=$(get_redfish_firmware_inventory)
      [[ -z "$_FW_INV_CACHE" ]] && _FW_INV_CACHE="__CONNECT_FAILED__"
    fi
  fi
  echo "$_FW_INV_CACHE"
}

_get_fw_ver() {
  local filter="$1" jq_path="${2:-.Version}"
  local inv
  inv=$(_get_fw_inv_cached)
  case "$inv" in
    __NO_BMC_IP__)      echo "N/A (no BMC IP)" ;;
    __CONNECT_FAILED__) echo "N/A (BMC unreachable)" ;;
    *)                  get_firmware_version_from_inventory "$inv" "$filter" "$jq_path" ;;
  esac
}

get_bmc_version_raw()    { _get_fw_ver 'contains("BMC")'; }
get_cpld_version_raw()   { _get_fw_ver 'contains("CPLD") and contains("Motherboard")'; }
get_bundle_version_raw() { _get_fw_ver 'contains("bundle_active")' '.Oem.AMD.VersionID.ComponentDetails'; }

# ----- TPM Info -----
# tpm2_getcap output cached to avoid calling it twice (once for model, once for revision)
_TPM_INFO_CACHE=""
_get_tpm_info_cached() {
  if [[ -z "$_TPM_INFO_CACHE" ]]; then
    if ! command -v tpm2_getcap &>/dev/null; then
      _TPM_INFO_CACHE="__NO_TPM__"
    else
      _TPM_INFO_CACHE=$(tpm2_getcap properties-fixed 2>/dev/null)
      [[ -z "$_TPM_INFO_CACHE" ]] && _TPM_INFO_CACHE="__TPM_EMPTY__"
    fi
  fi
  echo "$_TPM_INFO_CACHE"
}

get_tpm_model() {
  local tpm_info
  tpm_info=$(_get_tpm_info_cached)
  case "$tpm_info" in __NO_TPM__|__TPM_EMPTY__) echo "N/A"; return ;; esac
  local manufacturer vendor1 vendor2
  manufacturer=$(echo "$tpm_info" | awk '/MANUFACTURER/ {getline; getline; print $NF}' | tr -d '"')
  vendor1=$(echo "$tpm_info" | awk '/VENDOR_STRING_1/ {getline; getline; print $NF}' | tr -d '"')
  vendor2=$(echo "$tpm_info" | awk '/VENDOR_STRING_2/ {getline; getline; print $NF}' | tr -d '"')
  echo "${manufacturer} ${vendor1}${vendor2}" | xargs
}

get_tpm_revision() {
  local tpm_info
  tpm_info=$(_get_tpm_info_cached)
  case "$tpm_info" in __NO_TPM__|__TPM_EMPTY__) echo "N/A"; return ;; esac
  echo "$tpm_info" | awk '/TPM2_PT_FAMILY_INDICATOR:/{getline; getline; print $NF}' | tr -d '"'
}

get_tpm_details_json() {
  local model=$(get_tpm_model)
  local revision=$(get_tpm_revision)
  
  jq -n \
    --arg model "$model" \
    --arg revision "$revision" \
    '{
      "model": $model,
      "revision": $revision
    }'
}

# ----- CPU Info -----
get_cpu_model() { lscpu | grep "Model name:" | cut -d: -f2- | sed 's/^[ \t]*//' | head -n 1 || echo "$UNKNOWN"; }
get_cpu_counts() {
  local sockets
  local core_per_socket
  local threads_per_core
  sockets=$(lscpu | grep -i "Socket(s):" | awk '{print $2}')
  core_per_socket=$(lscpu | grep -i "Core(s) per socket:" | awk '{print $4}')
  threads_per_core=$(lscpu | grep -i "Thread(s) per core:" | awk '{print $4}')
  echo "$sockets Sockets x $core_per_socket Cores x $threads_per_core Threads"
}

get_cpu_max_freq() {
  local max_freq_khz
  max_freq_khz=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null)
  if [[ -n "$max_freq_khz" ]]; then
    echo "$(awk "BEGIN {printf \"%.2f GHz\", $max_freq_khz / 1000000}")"
  else
    echo "N/A"
  fi
}

get_mb_vendor() { dmidecode -s baseboard-manufacturer 2>/dev/null || echo "$UNKNOWN"; }

get_motherboard_sensors() {
  local ipmi_sensors
  ipmi_sensors=$(timeout 30 ipmitool sdr elist 2>/dev/null | grep -iE 'Temp|Voltage|Vcore|Pwr' | grep -vE 'Fan' | sed 's/^[ \t]*//')
  if [[ -n "$ipmi_sensors" ]]; then
    echo "$ipmi_sensors"
    return
  fi
  
  if command -v sensors &>/dev/null; then
    sensors 2>/dev/null | grep -E 'Temp|Voltage|Vcore' | grep -vE 'temp[0-9]+_input' | sed 's/^[ \t]*//' | head -n 5
  else
    echo "N/A (Install ipmitool or lm-sensors)"
  fi
}

# ----- Memory Info -----
get_memory_summary() { free -g | awk '/^Mem:/{print $2 " GB Total"}'; }

print_memory_details() {
  dmidecode -t 17 2>/dev/null | awk -v RS="" -v FS="\n" '
    BEGIN { count = 0 }
    {
      loc = "N/A"; sz = "N/A"; spd = "N/A"; pn = "N/A"; sn = "N/A";
      for (i = 1; i <= NF; i++) {
        line = $i;
        sub(/^[ \t]+/, "", line);
        if (line ~ /^Locator:/) { split(line, a, ": "); loc = a[2]; }
        else if (line ~ /^Size: No DIMM/) { sz = "No DIMM"; }
        else if (line ~ /^Size:/) { split(line, a, ": "); sz = a[2]; }
        else if (line ~ /^Configured Memory Speed:/) { split(line, a, ": "); spd = a[2]; }
        else if (line ~ /Speed:.*(MT\/s|MHz)/) { if (spd == "N/A") { split(line, a, ": "); spd = a[2]; } }
        else if (line ~ /^Part Number:/) { 
          split(line, a, ": "); 
          pn = a[2];
          sub(/^[ \t]+|[ \t]+$/, "", pn);
        }
        else if (line ~ /^Serial Number:/) {
          split(line, a, ": "); 
          sn = a[2];
          sub(/^[ \t]+|[ \t]+$/, "", sn);
        }
      }
      if (loc != "N/A" && loc != "") {
        count++;
        if (pn == "Not Specified" || pn == "") { pn = "N/A"; }
        if (sn == "Not Specified" || sn == "00000000" || sn == "") { sn = "N/A"; }
        if (spd ~ /Unknown/ || spd == "") { spd = "N/A"; }
        if (sz == "N/A" && loc ~ /DIMM/) { sz = "No DIMM"; }
        printf "  %-3d | %-10s | %-10s | %-12s | %-28s | %s\n", count, loc, sz, spd, pn, sn;
      }
    }
  '
}

# ----- Storage -----
# Helper: Print tree item with proper prefix
print_tree_item() {
  local prefix="$1" name="$2" type="$3" size="$4" mount="$5"
  printf "%s %s (%s) - %s%s\n" "$prefix" "$name" "$type" "$size" "${mount:+ -> $mount}"
}

# Helper: Print disk details (SN, FW, Health)
print_disk_details() {
  local serial="$1" fw="$2" health="$3" has_children="$4"
  echo "   |-- SN: $serial"
  echo "   |-- FW: $fw"
  [[ "$has_children" == "true" ]] && echo "   |-- Health: $health" || echo "   '-- Health: $health"
}

# Helper: Get SMART health status
get_health_status() {
  local dev_path="$1" name="$2" smart_info="$3"
  local health
  
  if command -v nvme &>/dev/null && [[ "$name" == nvme* ]]; then
    local nvme_info=$(nvme smart-log "$dev_path" 2>/dev/null)
    health=$(echo "$nvme_info" | grep 'critical_warning' | awk -F: '{print $2}' | xargs)
    [[ "$health" == "0" ]] && echo "OK" || echo "${RED}Warning${RESET}"
  else
    echo "$smart_info" | grep -i 'SMART overall-health\|SMART Health Status' | awk -F: '{print $2}' | xargs
  fi
}

# Helper: Extract field from smartctl output
extract_field() {
  local pattern="$1" field_num="${2:-2}" delimiter="${3:-:}"
  awk -F"$delimiter" -v fn="$field_num" '{print $fn}' | xargs
}

print_storage_tree() {
  local disk_count=0
  
  # Process regular disks
  while read -r name type size model; do
    [[ "$name" == "NAME" || "$type" != "disk" ]] && continue
    
    ((disk_count++))
    echo "  ${YELLOW}[$disk_count] $name ($type) - $size - $model${RESET}"
    
    local dev_path="/dev/$name"
    local smart_info=$(smartctl -i "$dev_path" 2>/dev/null)
    local serial=$(echo "$smart_info" | grep -i 'Serial Number' | extract_field 'Serial Number')
    local fw=$(echo "$smart_info" | grep -i 'Firmware Version' | extract_field 'Firmware Version')
    local health=$(get_health_status "$dev_path" "$name" "$smart_info")
    
    # Collect partitions and LVM volumes
    local lvm_volumes=() partitions=()
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      read -r pname ptype psize pmount <<< "$line"
      [[ "$pname" == "$name" ]] && continue
      [[ "$ptype" == "lvm" ]] && lvm_volumes+=("$pname|$ptype|$psize|$pmount")
      [[ "$ptype" == "part" ]] && partitions+=("$pname|$ptype|$psize|$pmount")
    done < <(lsblk -lo NAME,TYPE,SIZE,MOUNTPOINT -n "$dev_path")
    
    # Print details and children
    print_disk_details "$serial" "$fw" "$health" "$([[ ${#lvm_volumes[@]} -gt 0 ]] && echo "true" || echo "false")"
    
    # Print LVM volume with partitions as children
    for lvm_line in "${lvm_volumes[@]}"; do
      IFS='|' read -r pname ptype psize pmount <<< "$lvm_line"
      print_tree_item "   '--" "$pname" "$ptype" "$psize" "$pmount"
      
      # Print partitions under LVM
      local idx=0 part_count=${#partitions[@]}
      for part_line in "${partitions[@]}"; do
        ((idx++))
        IFS='|' read -r pname ptype psize pmount <<< "$part_line"
        local prefix=$([[ $idx -eq $part_count ]] && echo "       '--" || echo "       |--")
        print_tree_item "$prefix" "$pname" "$ptype" "$psize" "$pmount"
      done
    done
  done < <(lsblk -do NAME,TYPE,SIZE,MODEL | sort -V)
  
  # Process MegaRAID controllers
  local megaraid_devices=$(smartctl --scan 2>/dev/null | grep -i 'megaraid')
  [[ -z "$megaraid_devices" ]] && return
  
  echo ""
  echo "  ${CYAN}MegaRAID Controller Detected${RESET}"
  
  while IFS= read -r megaraid_line; do
    [[ -z "$megaraid_line" ]] && continue
    
    local device_path=$(echo "$megaraid_line" | awk '{print $1}')
    local device_driver=$(echo "$megaraid_line" | awk '{print $3}')
    [[ -z "$device_path" || -z "$device_driver" ]] && continue
    
    ((disk_count++))
    local megaraid_info=$(smartctl -a -d "$device_driver" "$device_path" 2>/dev/null)
    
    local model=$(echo "$megaraid_info" | grep -iE 'Product:|Device Model|Model Number' | head -1 | sed -E 's/.*:\s*//' | xargs)
    local serial=$(echo "$megaraid_info" | grep -i 'Serial number' | awk '{print $3}' | xargs)
    local fw=$(echo "$megaraid_info" | grep -i 'Revision' | awk '{print $2}' | xargs)
    local size=$(echo "$megaraid_info" | grep -iE 'User Capacity:|Size/Capacity' | head -1 | sed -E 's/.*\[([^]]+)\].*/\1/' | xargs)
    local health=$(echo "$megaraid_info" | grep -i 'SMART Health Status' | extract_field 'SMART Health Status')
    
    echo "  ${YELLOW}[$disk_count] MegaRAID Device - ${size:-N/A} - ${model:-$UNKNOWN}${RESET}"
    print_disk_details "${serial:-N/A}" "${fw:-N/A}" "${health:-N/A}" "false"
  done <<< "$megaraid_devices"
}

# ----- GPU Info -----
get_gpu_vbios_global() {
  local amd_smi_path=$(command -v amd-smi)
  if [[ -n "$amd_smi_path" && -x "$amd_smi_path" ]]; then
    "$amd_smi_path" 2>/dev/null | grep "VBIOS version:" | awk -F: '{print $2}' | xargs
  fi
}

print_gpu_info() {
  local rocm_smi_path=$(command -v rocm-smi)
  local amd_smi_path=$(command -v amd-smi)
  local nvidia_smi_path=$(command -v nvidia-smi)
  local gpu_count=0

  if [[ -n "$rocm_smi_path" && -x "$rocm_smi_path" ]]; then
    local rocm_output
    rocm_output=$("$rocm_smi_path" --showproductname --showbus --json 2>/dev/null | grep '^[{\[]')
    
    # Validate JSON before parsing
    if [[ -n "$rocm_output" ]] && echo "$rocm_output" | jq empty 2>/dev/null; then
      local gpus
      gpus=$(echo "$rocm_output" | jq -r '. | to_entries[] | "\(.key | sub("card";"")),\(.value."Card Series"),\(.value."PCI Bus")"' 2>/dev/null)
      
      if [[ -n "$gpus" ]]; then
        while IFS=, read -r id name pci; do
          ((gpu_count++))
          local serial vbios
          serial=$("$rocm_smi_path" -d "$id" --showserial 2>/dev/null | grep '^GPU.*Serial Number' | awk -F: '{print $NF}' | xargs)
          vbios=$("$rocm_smi_path" -d "$id" --showvbios 2>/dev/null | grep '^GPU.*VBIOS version' | awk -F: '{print $NF}' | xargs)
          
          [[ -z "$serial" ]] && serial="N/A"
          [[ -z "$vbios" ]] && vbios="N/A"

          echo "  ${YELLOW}[$gpu_count] $name${RESET} @ $pci (GPU ID: $id)"
          echo "    |- SN: $serial"
          echo "    '- VBIOS: $vbios"
        done <<< "$gpus"
        return
      fi
    else
      if [[ -n "$rocm_output" ]]; then
        echo "  ${YELLOW}Warning: rocm-smi returned invalid JSON${RESET}" >&2
      fi
    fi
  fi

  if [[ -n "$amd_smi_path" && -x "$amd_smi_path" ]]; then
    local amd_gpus_json
    amd_gpus_json=$("$amd_smi_path" --show-pci-bus --show-product-name --json 2>/dev/null)
    
    if [[ -n "$amd_gpus_json" && "$amd_gpus_json" != "{}" ]]; then
      # Validate JSON before parsing
      if echo "$amd_gpus_json" | jq empty 2>/dev/null; then
        local global_vbios
        global_vbios=$(get_gpu_vbios_global)
        if [[ -n "$global_vbios" ]]; then
            echo "  ${YELLOW}Global VBIOS:${RESET} $global_vbios"
        fi
        local parsed_output
        parsed_output=$(echo "$amd_gpus_json" | jq -r 'keys[] as $key | .[$key] | "\(.product_name)|\(.pci_bus)|" + ($key|tostring)' 2>&1)
        if [[ $? -eq 0 && -n "$parsed_output" ]]; then
          echo "$parsed_output" | while IFS='|' read -r pname pbus pid; do
            ((gpu_count++))
            echo "  ${YELLOW}[$gpu_count] $pname${RESET} @ $pbus (ID: $pid)"
          done
          return
        else
          echo "  ${YELLOW}Warning: Failed to parse GPU data from amd-smi${RESET}" >&2
        fi
      else
        echo "  ${YELLOW}Warning: amd-smi returned invalid JSON${RESET}" >&2
      fi
    fi
  fi

  if [[ -n "$nvidia_smi_path" && -x "$nvidia_smi_path" ]]; then
    local nvidia_gpus
    nvidia_gpus=$("$nvidia_smi_path" --query-gpu=name,pci.bus_id,vbios_version,serial --format=csv,noheader 2>/dev/null)
    
    if [[ -n "$nvidia_gpus" ]]; then
      while IFS=, read -r name pci vbios serial; do
        ((gpu_count++))
        echo "  ${YELLOW}[$gpu_count] $name${RESET} @ $pci"
        echo "    |- SN: $serial"
        echo "    '- VBIOS: $vbios"
      done <<< "$nvidia_gpus"
      return
    fi
  fi
  
  echo "  No AMD, NVIDIA, or ROCm GPU tools found or no GPUs detected."
}

# ----- PCIe Device Info -----
print_pcie_info() {
  local pcie_devs
  pcie_devs=$(lspci | grep -iE 'VGA|Ethernet|Non-Volatile memory controller' | awk '{print $1}')
  
  if [[ -z "$pcie_devs" ]]; then
      echo "  No key PCIe devices found."
      return
  fi
  
  echo "  [#] Device @ Bus [Current Speed, Width | Max Speed, Width]"
  local count=0
  for dev in $pcie_devs; do
    ((count++))
    local desc
    desc=$(lspci -s "$dev" | cut -d: -f3-)
    local status
    status=$(lspci -vvv -s "$dev" 2>/dev/null | grep -iE 'LnkSta:|LnkCap:')
    
    local lnk_sta
    local lnk_cap
    lnk_sta=$(echo "$status" | grep 'LnkSta:' | sed 's/.*LnkSta: *//' | cut -d, -f1-2)
    lnk_cap=$(echo "$status" | grep 'LnkCap:' | sed 's/.*LnkCap: *//' | cut -d, -f1-2)
    
    echo "  ${YELLOW}[$count] $desc${RESET}"
    echo "    '- $dev [$lnk_sta | $lnk_cap]"
  done
}

# ----- NIC Info -----
print_nic_info() {
  local interfaces
  interfaces=$(ip -o link show | awk -F': ' '{print $2}' | grep -vE '^lo|^docker|^veth|^br-')
  local count=0

  for iface in $interfaces; do
    ((count++))
    echo "  ${YELLOW}[$count] Interface: $iface${RESET}"
    local ethtool_info
    ethtool_info=$(ethtool -i "$iface" 2>/dev/null)
    local bus
    bus=$(echo "$ethtool_info" | grep "bus-info" | awk '{print $2}')
    local link_status
    link_status=$(ethtool "$iface" 2>/dev/null | grep -E 'Speed:|Duplex:|Link detected:' | sed 's/^[ \t]*//' | tr '\n' ' | ')
    link_status=$(echo "$link_status" | sed 's/ | $//')

    local fw
    fw=$(echo "$ethtool_info" | grep "firmware-version" | awk -F': ' '{print $2}')
    local mac
    mac=$(ip link show "$iface" 2>/dev/null | grep -iE "link/(ether|infiniband)" | awk '{print $2}')

    declare -a items=()
    
    items+=("MAC: $mac")
    items+=("Bus: $bus")
    items+=("FW: $fw")
    items+=("Status: $link_status")

    if [[ -n "$bus" && "$bus" != "N/A" && "$bus" != "usb-"* ]]; then
      local lspci_info
      lspci_info=$(lspci -vvv -s "$bus" 2>/dev/null)
      local pn
      pn=$(echo "$lspci_info" | grep -i -A 2 '\[PN\]' | grep 'Part number' | sed 's/.*Part number: //' | xargs)
      local sn
      sn=$(echo "$lspci_info" | grep -i -A 2 '\[SN\]' | grep 'Serial number' | sed 's/.*Serial number: //' | xargs)
      
      [[ -n "$pn" ]] && items+=("Part#[PN]: $pn")
      [[ -n "$sn" ]] && items+=("Serial#[SN]: $sn")
    fi

    local max_idx=$(( ${#items[@]} - 1 ))
    for i in "${!items[@]}"; do
      if [[ $i -eq $max_idx ]]; then
        echo "    '- ${items[$i]}"
      else
        echo "    |- ${items[$i]}"
      fi
    done
  done
}


# ----- PSU / Fan Info -----
print_psu_info() {
  local psu_info
  psu_info=$(dmidecode -t 39 2>/dev/null | grep -E 'Location:|Model Part Number:|Serial Number:')
  
  if [[ -z "$psu_info" ]]; then
      echo "  No PSU info found via dmidecode (type 39)."
      return
  fi

  echo "$psu_info" | sed 's/^[ \t]*//' | awk '
    BEGIN { FS = ": "; count = 0; }
    /Location:/ { 
      if (loc) { 
        count++;
        printf "  %-3d | %-10s | %-20s | %s\n", count, loc, pn, sn 
      } 
      loc=$2; 
      pn="N/A"; 
      sn="N/A";
    }
    /Model Part Number:/ { pn=$2 }
    /Serial Number:/ { sn=$2 }
    END { 
      if (loc) { 
        count++;
        printf "  %-3d | %-10s | %-20s | %s\n", count, loc, pn, sn 
      } 
    }
  '
}

print_fan_list() {
  local fan_names
  # Get only the fan names (first column), remove RPM and other data
  fan_names=$(timeout 30 ipmitool sensor list 2>/dev/null | grep -i "Fan" | awk -F'|' '{print $1}' | sed 's/^[ \t]*//;s/[ \t]*$//' | sed 's/ RPM$//' | sort -u)
  
  if [[ -z "$fan_names" ]]; then
      echo "  No Fan info found via ipmitool sensor list."
      return
  fi

  local count=0
  while IFS= read -r name; do
      ((count++))
      printf "  %-3d | %s\n" "$count" "$name"
  done <<< "$fan_names"
}

# ----- System Logs -----
get_dmesg_errors() {
  # Removed tail to show all errors
  dmesg --level=err,warn 2>/dev/null | grep -iE '(error|fail|degrade|mce|critical)'
}

print_event_list() {
  local events="$1" empty_msg="$2"
  if [[ -z "$events" ]]; then
    echo "  $empty_msg"
  else
    local count=0
    echo -e "${RED}$events${RESET}" | while IFS= read -r line; do
      ((count++))
      printf "  [%2d] %s\n" "$count" "$line"
    done
  fi
}

print_dmesg_errors() { print_event_list "$(get_dmesg_errors)" "No errors found in dmesg."; }

get_bmc_events() {
  # Removed tail to show all critical events
  timeout 30 ipmitool sel list 2>/dev/null | grep -viE '(Informational|OK|full|Presence detected|Power-on)'
}

print_bmc_events() { print_event_list "$(get_bmc_events)" "No non-informational events found in BMC SEL."; }

# -------------------------------------------------------------------
# ----- JSON OUTPUT FUNCTIONS ---------------------------------------
# -------------------------------------------------------------------
get_memory_details_json() {
  dmidecode -t 17 2>/dev/null | awk -v RS="" -v FS="\n" '
    {
      loc = "N/A"; sz = "N/A"; spd = "N/A"; pn = "N/A"; sn = "N/A";
      for (i = 1; i <= NF; i++) {
        line = $i;
        sub(/^[ \t]+/, "", line);
        if (line ~ /^Locator:/) { split(line, a, ": "); loc = a[2]; }
        else if (line ~ /^Size: No DIMM/) { sz = "No DIMM"; }
        else if (line ~ /^Size:/) { split(line, a, ": "); sz = a[2]; }
        else if (line ~ /^Configured Memory Speed:/) { split(line, a, ": "); spd = a[2]; }
        else if (line ~ /Speed:.*(MT\/s|MHz)/) { if (spd == "N/A") { split(line, a, ": "); spd = a[2]; } }
        else if (line ~ /^Part Number:/) { 
          split(line, a, ": "); 
          pn = a[2];
          sub(/^[ \t]+|[ \t]+$/, "", pn);
        }
        else if (line ~ /^Serial Number:/) {
          split(line, a, ": "); 
          sn = a[2];
          sub(/^[ \t]+|[ \t]+$/, "", sn);
        }
      }
      if (loc != "N/A" && loc != "") {
        if (pn == "Not Specified" || pn == "") { pn = "N/A"; }
        if (sn == "Not Specified" || sn == "00000000" || sn == "") { sn = "N/A"; }
        if (spd ~ /Unknown/ || spd == "") { spd = "N/A"; }
        if (sz == "N/A" && loc ~ /DIMM/) { sz = "No DIMM"; }
        
        gsub(/"/, "\\\"", loc); gsub(/"/, "\\\"", sz);
        gsub(/"/, "\\\"", spd); gsub(/"/, "\\\"", pn); gsub(/"/, "\\\"", sn);
        
        printf "{\"locator\": \"%s\", \"size\": \"%s\", \"speed\": \"%s\", \"part_number\": \"%s\", \"serial_number\": \"%s\"}\n", loc, sz, spd, pn, sn;
      }
    }
  ' | jq -s '.' 2>/dev/null || echo '[]'
}

get_storage_details_json() {
  (
    lsblk -do NAME,TYPE,SIZE,MODEL | sort -V | while read -r name type size model; do
      [[ "$name" == "NAME" ]] && continue
      [[ "$type" != "disk" ]] && continue
      
      local dev_path="/dev/$name"
      local smart_info
      smart_info=$(smartctl -i "$dev_path" 2>/dev/null)
      local serial
      local fw
      local health
      serial=$(echo "$smart_info" | grep -i 'Serial Number' | awk -F: '{print $2}' | xargs)
      fw=$(echo "$smart_info" | grep -i 'Firmware Version' | awk -F: '{print $2}' | xargs)
      
      if command -v nvme &>/dev/null && [[ "$name" == nvme* ]]; then
          local nvme_info
          nvme_info=$(nvme smart-log "$dev_path" 2>/dev/null)
          health=$(echo "$nvme_info" | grep 'critical_warning' | awk -F: '{print $2}' | xargs)
          [[ "$health" == "0" ]] && health="OK" || health="Warning"
      else
          health=$(echo "$smart_info" | grep -i 'SMART overall-health' | awk -F: '{print $2}' | xargs)
      fi
      
      # Partitions removed from JSON output per request

      jq -n \
        --arg name "$name" --arg type "$type" --arg size "$size" --arg model "$model" \
        --arg sn "$serial" --arg fw "$fw" --arg health "$health" \
        '{ "name": $name, "type": $type, "size": $size, "model": $model,
          "serial": $sn, "firmware": $fw, "health": $health }'
    done
    
    # Check for MegaRAID controllers
    local megaraid_devices
    megaraid_devices=$(smartctl --scan 2>/dev/null | grep -i 'megaraid')
    
    if [[ -n "$megaraid_devices" ]]; then
      while IFS= read -r megaraid_line; do
        [[ -z "$megaraid_line" ]] && continue
        
        local device_path=$(echo "$megaraid_line" | awk '{print $1}')
        local device_driver=$(echo "$megaraid_line" | awk '{print $3}')
        
        if [[ -n "$device_path" && -n "$device_driver" ]]; then
          # Get model/product name from MegaRAID device
          local megaraid_info
          megaraid_info=$(smartctl -a -d "$device_driver" "$device_path" 2>/dev/null)
          local model=$(echo "$megaraid_info" | grep -iE 'Product:|Device Model|Model Number' | head -1 | sed -E 's/.*:\s*//' | xargs)
          local serial=$(echo "$megaraid_info" | grep -i 'Serial number' | awk '{print $3}' | xargs)
          local revision=$(echo "$megaraid_info" | grep -i 'Revision' | awk '{print $2}' | xargs)
          local size=$(echo "$megaraid_info" | grep -iE 'User Capacity:|Size/Capacity' | head -1 | sed -E 's/.*\[([^]]+)\].*/\1/' | xargs)
          local health=$(echo "$megaraid_info" | grep -i 'SMART Health Status' | awk -F: '{print $2}' | xargs)
          
          [[ -z "$model" ]] && model="$UNKNOWN"
          [[ -z "$serial" ]] && serial="N/A"
          [[ -z "$revision" ]] && revision="N/A"
          [[ -z "$size" ]] && size="N/A"
          [[ -z "$health" ]] && health="N/A"
          
          jq -n \
            --arg name "$device_path" --arg type "megaraid" --arg size "$size" \
            --arg model "$model" --arg sn "$serial" --arg fw "$revision" --arg health "$health" \
            '{ "name": $name, "type": $type, "size": $size, "model": $model,
              "serial": $sn, "firmware": $fw, "health": $health }'
        fi
      done <<< "$megaraid_devices"
    fi
  ) | jq -s '.' 2>/dev/null || echo '[]'
}

get_cpu_details_json() {
    # Temperature removed per request
    jq -n \
      --arg model "$(get_cpu_model | tr '\n' '; ')" \
      --arg counts "$(get_cpu_counts)" \
      --arg max_freq "$(get_cpu_max_freq)" \
      '{ "model": $model, "counts": $counts, "max_frequency": $max_freq }'
}

get_motherboard_details_json() {
    # Sensors removed from motherboard block per request (moved to top level)
    jq -n \
      --arg vendor "$(get_mb_vendor)" \
      --arg pn "$(get_mb_pn)" \
      --arg sn "$(get_mb_sn)" \
      '{ "vendor": $vendor, "part_number": $pn, "serial_number": $sn }'
}

get_sensors_json() {
    get_motherboard_sensors | jq -R -s . 2>/dev/null || echo '""'
}

get_gpu_details_json() {
  local rocm_smi_path=$(command -v rocm-smi)
  local amd_smi_path=$(command -v amd-smi)
  local nvidia_smi_path=$(command -v nvidia-smi)

  if [[ -n "$rocm_smi_path" && -x "$rocm_smi_path" ]]; then
    local gpus_json
    gpus_json=$( (
      local rocm_output
      rocm_output=$("$rocm_smi_path" --showproductname --showbus --json 2>/dev/null | grep '^[{\[]')
      
      # Validate JSON before parsing
      if [[ -n "$rocm_output" ]] && echo "$rocm_output" | jq empty 2>/dev/null; then
        local gpus
        gpus=$(echo "$rocm_output" | jq -r '. | to_entries[] | "\(.key | sub("card";"")),\(.value."Card Series"),\(.value."PCI Bus")"' 2>/dev/null)
        if [[ -n "$gpus" ]]; then
          while IFS=, read -r id name pci; do
            local serial
            local vbios
            serial=$("$rocm_smi_path" -d "$id" --showserial 2>/dev/null | grep '^GPU.*Serial Number' | awk -F: '{print $NF}' | xargs)
            vbios=$("$rocm_smi_path" -d "$id" --showvbios 2>/dev/null | grep '^GPU.*VBIOS version' | awk -F: '{print $NF}' | xargs)
            
            [[ -z "$serial" ]] && serial="N/A"
            [[ -z "$vbios" ]] && vbios="N/A"
            
            jq -n \
              --arg name "$name" --arg pci "$pci" --arg vbios "$vbios" --arg sn "$serial" --arg id "$id" \
              '{"name": $name, "pci_bus": $pci, "vbios": $vbios, "serial": $sn, "gpu_id": $id}'
          done <<< "$gpus"
        fi
      else
        echo "Warning: rocm-smi returned invalid JSON" >&2
      fi
    ) | jq -s '.' 2>/dev/null )
    
    # Validate result and check length
    if [[ -n "$gpus_json" ]] && echo "$gpus_json" | jq empty 2>/dev/null; then
      local gpu_count=$(echo "$gpus_json" | jq 'length' 2>/dev/null || echo "0")
      if [[ "$gpu_count" -gt 0 ]]; then
        echo "$gpus_json"
        return
      fi
    fi
  fi
  
  if [[ -n "$amd_smi_path" && -x "$amd_smi_path" ]]; then
    local amd_gpus_json
    amd_gpus_json=$("$amd_smi_path" --show-pci-bus --show-product-name --json 2>/dev/null)
    if [[ -n "$amd_gpus_json" && "$amd_gpus_json" != "{}" ]]; then
      # Validate and parse JSON with error handling
      local parsed_result
      parsed_result=$(echo "$amd_gpus_json" | jq '[ keys[] as $key | .[$key] | { "name": "\(.product_name)", "pci_bus": .pci_bus, "gpu_id": $key } ]' 2>/dev/null || echo '[]')
      if [[ -n "$parsed_result" && "$parsed_result" != "[]" ]]; then
        echo "$parsed_result"
        return
      fi
    fi
  fi

  if [[ -n "$nvidia_smi_path" && -x "$nvidia_smi_path" ]]; then
    ("$nvidia_smi_path" --query-gpu=name,pci.bus_id,vbios_version,serial --format=csv,noheader 2>/dev/null | \
    while IFS=, read -r name pci vbios serial; do
      jq -n \
        --arg name "$name" --arg pci "$pci" --arg vbios "$vbios" --arg sn "$serial" \
        '{"name": $name, "pci_bus": $pci, "vbios": $vbios, "serial": $sn}'
    done) | jq -s '.' 2>/dev/null || echo '[]'
    return
  fi
  
  echo "[]"
}

get_pcie_details_json() {
  (
    local pcie_devs
    pcie_devs=$(lspci | grep -iE 'VGA|Ethernet|Non-Volatile memory controller' | awk '{print $1}')
    if [[ -n "$pcie_devs" ]]; then
      for dev in $pcie_devs; do
        local desc
        desc=$(lspci -s "$dev" | cut -d: -f3- | xargs)
        local status
        status=$(lspci -vvv -s "$dev" 2>/dev/null | grep -iE 'LnkSta:|LnkCap:')
        local lnk_sta
        local lnk_cap
        lnk_sta=$(echo "$status" | grep 'LnkSta:' | sed 's/.*LnkSta: *//' | cut -d, -f1-2 | xargs)
        lnk_cap=$(echo "$status" | grep 'LnkCap:' | sed 's/.*LnkCap: *//' | cut -d, -f1-2 | xargs)
        
        jq -n \
          --arg dev "$dev" --arg desc "$desc" --arg lnk_sta "$lnk_sta" --arg lnk_cap "$lnk_cap" \
          '{"device_bus": $dev, "description": $desc, "link_status": $lnk_sta, "link_capacity": $lnk_cap}'
      done
    fi
  ) | jq -s '.' 2>/dev/null || echo '[]'
}

get_nic_details_json() {
  (
    local interfaces
    interfaces=$(ip -o link show | awk -F': ' '{print $2}' | grep -vE '^lo|^docker|^veth|^br-')
    for iface in $interfaces; do
      local ethtool_info
      ethtool_info=$(ethtool -i "$iface" 2>/dev/null)
      local bus
      bus=$(echo "$ethtool_info" | grep "bus-info" | awk '{print $2}')
      local fw
      fw=$(echo "$ethtool_info" | grep "firmware-version" | awk -F': ' '{print $2}')
      local mac
      mac=$(ip link show "$iface" 2>/dev/null | grep -iE "link/(ether|infiniband)" | awk '{print $2}')
      local link_status
      link_status=$(ethtool "$iface" 2>/dev/null | grep -E 'Speed:|Duplex:|Link detected:' | sed 's/^[ \t]*//' | tr '\n' ' | ')
      link_status=$(echo "$link_status" | sed 's/ | $//')
      
      local pn="N/A"
      local sn="N/A"
      if [[ -n "$bus" && "$bus" != "N/A" && "$bus" != "usb-"* ]]; then
        local lspci_info
        lspci_info=$(lspci -vvv -s "$bus" 2>/dev/null)
        pn=$(echo "$lspci_info" | grep -i -A 2 '\[PN\]' | grep 'Part number' | sed 's/.*Part number: //' | xargs)
        sn=$(echo "$lspci_info" | grep -i -A 2 '\[SN\]' | grep 'Serial number' | sed 's/.*Serial number: //' | xargs)
        [[ -z "$pn" ]] && pn="N/A"
        [[ -z "$sn" ]] && sn="N/A"
      fi
      
      jq -n \
        --arg iface "$iface" --arg mac "$mac" --arg bus "$bus" \
        --arg fw "$fw" --arg pn "$pn" --arg sn "$sn" --arg status "$link_status" \
        '{"interface": $iface, "mac": $mac, "bus": $bus, "firmware": $fw, "part_number": $pn, "serial_number": $sn, "link_status": $status}'
    done
  ) | jq -s '.' 2>/dev/null || echo '[]'
}

get_psu_details_json() {
  dmidecode -t 39 2>/dev/null | \
  sed 's/^[ \t]*//' | \
  awk '
    BEGIN { FS = ": " }
    /Location:/ { 
      if (loc) { 
        gsub(/"/, "\\\"", loc); gsub(/"/, "\\\"", pn); gsub(/"/, "\\\"", sn);
        printf "{\"location\": \"%s\", \"part_number\": \"%s\", \"serial_number\": \"%s\"}\n", loc, pn, sn
      } 
      loc=$2; 
      pn="N/A"; 
      sn="N/A";
    }
    /Model Part Number:/ { pn=$2 }
    /Serial Number:/ { sn=$2 }
    END { 
      if (loc) { 
        gsub(/"/, "\\\"", loc); gsub(/"/, "\\\"", pn); gsub(/"/, "\\\"", sn);
        printf "{\"location\": \"%s\", \"part_number\": \"%s\", \"serial_number\": \"%s\"}\n", loc, pn, sn
      } 
    }
  ' | jq -s '.' 2>/dev/null || echo '[]'
}

get_fan_details_json() {
  (timeout 30 ipmitool sensor list 2>/dev/null | grep -i "Fan" | awk -F'|' '{print $1}' | sed 's/^[ \t]*//;s/[ \t]*$//' | sed 's/ RPM$//' | sort -u | \
  awk '{ print "{\"index\": " NR ", \"name\": \"" $0 "\"}" }') | jq -s '.' 2>/dev/null || echo '[]'
}

print_report_human() {
  print_divider
  print_centered_line "${CYAN} _____ __  __  _____ _____${RESET}"
  print_centered_line "${CYAN} / ____|  \/  |/ ____|_   _|${RESET}"
  print_centered_line "${CYAN}| (___ | \  / | |      | |  ${RESET}"
  print_centered_line "${CYAN} \___ \| |\/| | |      | |  ${RESET}"
  print_centered_line "${CYAN} ____) | |  | | |____ _| |_ ${RESET}"
  print_centered_line "${CYAN}|_____/|_|  |_|\_____|_____|${RESET}"
  print_centered_line "${YELLOW}Sanity Check${RESET}"
  print_centered_line "${WHITE}$(date +"%Y-%m-%d %H:%M:%S %Z")${RESET}"
  print_divider

  print_section_header "System & Motherboard"
  print_line "$(print_label_value_aligned "Hostname:" "$(get_hostname)")"
  print_line "$(print_label_value_aligned "OS Version:" "$(get_os_version)")"
  print_line "$(print_label_value_aligned "Kernel Version:" "$(get_kernel_version)")"
  print_line "$(print_label_value_aligned "System PN:" "$(get_system_pn)")"
  print_line "$(print_label_value_aligned "System SN:" "$(get_system_sn)")"
  print_line "$(print_label_value_aligned "MB Vendor:" "$(get_mb_vendor)")"
  print_line "$(print_label_value_aligned "Motherboard PN:" "$(get_mb_pn)")"
  print_line "$(print_label_value_aligned "Motherboard SN:" "$(get_mb_sn)")"
  print_line "$(print_label_value_aligned "Chassis SN:" "$(get_chassis_sn)")"
  print_divider
  print_line "$(print_label_value_aligned "BIOS Version:" "$(get_bios_version)")"
  print_line "$(print_label_value_aligned "BMC Version:" "$(get_bmc_version_raw)")"
  print_line "$(print_label_value_aligned "CPLD Version:" "$(get_cpld_version_raw)")"
  print_line "$(print_label_value_aligned "Bundle Version:" "$(get_bundle_version_raw)")"
  print_divider
  
  print_section_header "TPM (Trusted Platform Module)"
  print_line "$(print_label_value_aligned "TPM Model:" "$(get_tpm_model)")"
  print_line "$(print_label_value_aligned "TPM Revision:" "$(get_tpm_revision)")"
  print_divider
  
  print_section_header "Network Info (OS & BMC)"
  print_line "$(print_label_value_aligned "SSH Source:" "$(get_ssh_ip_source)")"
  print_line "$(print_label_value_aligned "SSH Address:" "$(get_ssh_ip)")"
  print_line "$(print_label_value_aligned "SSH Subnet:" "$(get_ssh_subnet)")"
  print_line "$(print_label_value_aligned "SSH Gateway:" "$(get_ssh_gateway)")"
  print_line "$(print_label_value_aligned "SSH MAC:" "$(get_ssh_mac)")"
  print_line "$(print_label_value_aligned "SSH Interface:" "$(get_ssh_interface)")"
  print_line "$(print_label_value_aligned "BMC Source:" "$(get_bmc_ip_source)")"
  print_line "$(print_label_value_aligned "BMC IP:" "$(get_bmc_ip)")"
  print_line "$(print_label_value_aligned "BMC Subnet:" "$(get_bmc_subnet)")"
  print_line "$(print_label_value_aligned "BMC Gateway:" "$(get_bmc_gateway)")"
  print_line "$(print_label_value_aligned "BMC MAC:" "$(get_bmc_mac)")"
  print_divider
  
  print_section_header "CPU & Memory"
  print_line "$(print_label_value_aligned "CPU Model:" "$(get_cpu_model)")"
  print_line "$(print_label_value_aligned "Max Frequency:" "$(get_cpu_max_freq)")"
  print_line "$(print_label_value_aligned "CPU Counts:" "$(get_cpu_counts)")"
  # Removed Avg Core Temp per request
  print_line "$(print_label_value_aligned "Memory:" "$(get_memory_summary)")"
  print_line "  --- Memory Module Details (# | Locator | Size | Speed | Part# | SN#) ---"
  print_line "  $(printf '%-3s | %-10s | %-10s | %-12s | %-28s | %s\n' "#" "Locator" "Size" "Speed" "Part Number" "Serial Number")"
  while IFS= read -r line; do
    print_line "$line"
  done < <(print_memory_details)
  print_divider

  print_section_header "Network Interfaces (NICs)"
  while IFS= read -r line; do
    print_line "$line"
  done < <(print_nic_info)
  print_divider

  print_section_header "Accelerator Devices (GPUs)"
  while IFS= read -r line; do
    print_line "$line"
  done < <(print_gpu_info)
  print_divider

  print_section_header "PCIe Devices (Link Status)"
  while IFS= read -r line; do
    print_line "$line"
  done < <(print_pcie_info)
  print_divider

  print_section_header "Storage Devices"
  while IFS= read -r line; do
    print_line "$line"
  done < <(print_storage_tree)
  print_divider

  print_section_header "Power Supplies (PSUs)"
  print_line "  $(printf '%-3s | %-10s | %-20s | %s\n' "#" "Location" "Part Number" "Serial Number")"
  while IFS= read -r line; do
    print_line "$line"
  done < <(print_psu_info)
  print_divider
  
  print_section_header "Fan Status (BMC Sensors)"
  while IFS= read -r line; do
    print_line "$line"
  done < <(print_fan_list)
  print_divider

  # Sensors moved after Fans per request
  print_section_header "Motherboard Sensors (BMC/OS)"
  print_line "$(print_label_value_aligned "Sensors:" "$(get_motherboard_sensors)")"
  print_divider

  print_section_header "dmesg Errors (Unlimited)"
  while IFS= read -r line; do
    print_line "$line"
  done < <(print_dmesg_errors)
  print_divider

  print_section_header "BMC System Event Log (Unlimited Critical)"
  while IFS= read -r line; do
    print_line "$line"
  done < <(print_bmc_events)
  print_divider
}

print_report_json() {
  # Helper to safely get JSON output with fallback
  safe_json() {
    local result
    result=$("$@" 2>&1)
    local exit_code=$?
    
    if [[ $exit_code -ne 0 ]]; then
      echo "Warning: Error collecting data from $1" >&2
      echo "[]"
      return 1
    fi
    
    # Validate JSON
    if ! echo "$result" | jq empty 2>/dev/null; then
      echo "Warning: Invalid JSON from $1" >&2
      echo "[]"
      return 1
    fi
    
    echo "$result"
    return 0
  }
  
  # Note: using raw getters for Firmware versions in JSON to maintain structure
  jq -n \
    --arg hostname "$(get_hostname)" \
    --arg os_version "$(get_os_version)" \
    --arg kernel_version "$(get_kernel_version)" \
    --arg system_pn "$(get_system_pn)" \
    --arg system_sn "$(get_system_sn)" \
    --argjson mb_details "$(safe_json get_motherboard_details_json)" \
    --arg chassis_sn "$(get_chassis_sn)" \
    --arg bios_version "$(get_bios_version)" \
    --arg bmc_version "$(get_bmc_version_raw)" \
    --arg cpld_version "$(get_cpld_version_raw)" \
    --arg bkc_version "$(get_bundle_version_raw)" \
    --argjson tpm_details "$(safe_json get_tpm_details_json)" \
    --arg ssh_source "$(get_ssh_ip_source)" \
    --arg ssh_ip "$(get_ssh_ip)" \
    --arg ssh_subnet "$(get_ssh_subnet)" \
    --arg ssh_gateway "$(get_ssh_gateway)" \
    --arg ssh_mac "$(get_ssh_mac)" \
    --arg ssh_iface "$(get_ssh_interface)" \
    --arg bmc_source "$(get_bmc_ip_source)" \
    --arg bmc_ip "$(get_bmc_ip)" \
    --arg bmc_subnet "$(get_bmc_subnet)" \
    --arg bmc_gateway "$(get_bmc_gateway)" \
    --arg bmc_mac "$(get_bmc_mac)" \
    --argjson cpu_details "$(safe_json get_cpu_details_json)" \
    --arg memory_summary "$(get_memory_summary)" \
    --argjson memory_modules "$(safe_json get_memory_details_json)" \
    --argjson storage_devices "$(safe_json get_storage_details_json)" \
    --arg gpu_vbios_global "$(get_gpu_vbios_global)" \
    --argjson gpu_devices "$(safe_json get_gpu_details_json)" \
    --argjson pcie_devices "$(safe_json get_pcie_details_json)" \
    --argjson nic_devices "$(safe_json get_nic_details_json)" \
    --argjson psu_devices "$(safe_json get_psu_details_json)" \
    --argjson fan_devices "$(safe_json get_fan_details_json)" \
    --argjson sensors "$(safe_json get_sensors_json)" \
    --arg dmesg_errors "$(get_dmesg_errors | jq -R -s . 2>/dev/null || echo '""')" \
    --arg bmc_sel "$(get_bmc_events | jq -R -s . 2>/dev/null || echo '""')" \
    '{
      "system": {
        "hostname": $hostname,
        "os_version": $os_version,
        "kernel_version": $kernel_version,
        "system_pn": $system_pn,
        "system_sn": $system_sn,
        "motherboard": $mb_details,
        "chassis_sn": $chassis_sn
      },
      "firmware": {
        "bios_version": $bios_version,
        "bmc_version": $bmc_version,
        "cpld_version": $cpld_version,
        "bkc_version": $bkc_version
      },
      "tpm": $tpm_details,
      "network_ssh": {
        "source": $ssh_source,
        "ip_address": $ssh_ip,
        "subnet": $ssh_subnet,
        "gateway": $ssh_gateway,
        "mac": $ssh_mac,
        "interface": $ssh_iface
      },
      "network_bmc": {
        "source": $bmc_source,
        "ip_address": $bmc_ip,
        "subnet": $bmc_subnet,
        "gateway": $bmc_gateway,
        "mac": $bmc_mac
      },
      "cpu": {
        "info": $cpu_details
      },
      "memory": {
        "summary": $memory_summary,
        "modules": $memory_modules
      },
      "storage": $storage_devices,
      "accelerators_gpu": {
        "global_vbios": $gpu_vbios_global,
        "devices": $gpu_devices
      },
      "pcie_devices": $pcie_devices,
      "network_interfaces": $nic_devices,
      "power_and_fan": {
        "power_supplies": $psu_devices,
        "fans": $fan_devices
      },
      "sensors": $sensors,
      "logs": {
        "dmesg_errors": $dmesg_errors,
        "bmc_sel_critical": $bmc_sel
      }
    }'
}

# Shared function to determine JSON output path
determine_json_output_path() {
  local fname_host=$(get_hostname)
  local fname_sn=$(get_system_sn | tr -d '[:space:]')
  local fname_date=$(date -u +"%Y%m%dT%H%M%SZ")
  local fname="${fname_host}-${fname_sn}-sanitycheck-${fname_date}.json"

  if [[ -n "$EXPORT_PATH" ]]; then
    if [[ -d "$EXPORT_PATH" ]]; then
      echo "${EXPORT_PATH}/${fname}"
    else
      echo "$EXPORT_PATH"
    fi
  elif [[ "$(dirname "$(realpath "$0")" 2>/dev/null)" == "/tmp" ]]; then
    echo "/tmp/${fname}"
  else
    echo "$fname"
  fi
}

# Generate JSON first — this primes the firmware inventory cache so the human
# report reuses the same data, keeping both outputs consistent.
if ! command -v jq &>/dev/null; then
  echo "Warning: 'jq' not installed - JSON export skipped." >&2
else
  json_filename=$(determine_json_output_path)
  print_report_json > "$json_filename"
  echo "JSON report saved to: $json_filename" >&2
  JSON_OUTPUT_FILE="$json_filename"
fi

# Print human-readable report (reuses cached data from JSON generation above)
print_report_human

# Perform BOM check using the already-generated JSON file — avoids a third
# data collection pass and ensures the comparison is against the saved report.
if [[ -n "$BOM_FILE" ]]; then
  if ! command -v jq &>/dev/null; then
    echo "Error: --compare-bom requires 'jq' to be installed." >&2
    exit 1
  fi
  if [[ -n "$JSON_OUTPUT_FILE" && -f "$JSON_OUTPUT_FILE" ]]; then
    perform_bom_check "$BOM_FILE" "$JSON_OUTPUT_FILE"
  else
    echo "Error: Cannot run BOM check — JSON report was not generated." >&2
    exit 1
  fi
fi

# Generate PCIe topology diagram (runs for all output formats)
# Use exact path of lstopo, as openMPI bundles a lstopo that does not support --of png 
echo "---------- Get Graphical PCIe Topology Diagram ------------" >&2

# Determine PNG filename - always derive from JSON output file if available
if [[ -n "$JSON_OUTPUT_FILE" ]]; then
  topology_png="${JSON_OUTPUT_FILE%.json}_topology.png"
else
  fname_host=$(get_hostname)
  fname_sn=$(get_system_sn | tr -d '[:space:]')
  fname_date=$(date -u +"%Y%m%dT%H%M%SZ")
  topology_fname="${fname_host}-${fname_sn}-topology-${fname_date}.png"
  if [[ "$(dirname "$(realpath "$0")" 2>/dev/null)" == "/tmp" ]]; then
    topology_png="/tmp/${topology_fname}"
  else
    topology_png="$topology_fname"
  fi
fi

# Use exact path of lstopo, as openMPI bundles a lstopo that does not support --of png 
LSTOPO_OUTPUT=$(/usr/bin/lstopo --of png "$topology_png" 2>&1)
if [[ $? -eq 0 && -f "$topology_png" ]]; then
  echo "✓ PCIe topology diagram saved to: $topology_png" >&2
else
  echo "Warning: Failed to generate topology diagram" >&2
  if [[ -n "$LSTOPO_OUTPUT" ]]; then
    echo "lstopo error: $LSTOPO_OUTPUT" >&2
  fi
fi