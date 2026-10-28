#!/bin/bash
set -o pipefail
# run_sanity_check.sh — Real-time sanity check across all nodes in a rack.
# Each node runs FW → SW → BOM → PSU → Voltage → SEL checks in its own
# background process; the main loop polls status files and redraws the table live.
#
# Usage (multi-node):  run_sanity_check.sh <rack_num> <hostfile.csv> [--nodes N1,N2,...] [--result-file PATH]
# Usage (single-node): run_sanity_check.sh <rack_num> <os_ip> <bmc_ip> <bmc_pwd> [sys_sn]
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#   5  SN validation failed (node offline or SN mismatch)

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <rack_num> <hostfile.csv> [--nodes N1,N2,...]"
    echo "   OR: $0 <rack_num> <os_ip> <bmc_ip> <bmc_password> [system_sn]"
    echo ""
    echo "Examples:"
    echo "  Multi-node: $0 001 hosts.csv"
    echo "  Multi-node with filter: $0 001 hosts.csv --nodes 1,2,3"
    echo "  Single-node: $0 001 172.31.37.182 172.31.32.251 'ADMIN'"
    exit 1
fi

RACK_NUM="$1"
shift

# Parse optional named arguments: --nodes, --result-file
NODE_FILTER=""
RESULT_FILE=""
_remaining_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --nodes)       NODE_FILTER="$2"; shift 2 ;;
        --result-file) RESULT_FILE="$2"; shift 2 ;;
        *)             _remaining_args+=("$1"); shift ;;
    esac
done
set -- "${_remaining_args[@]}"

# Determine if this is single-node mode or hostfile mode
#   $1=OS_IP  $2=BMC_IP  $3=BMC_PWD  [$4=SN]
if [[ $# -ge 4 ]]; then
    OS_IP="$1"
    BMC_IP="$2"
    BMC_PWD="$3"
    SYSTEM_SN="${4:-}"  # Optional, will be auto-detected if not provided
    
    # Create temporary hostfile
    TEMP_HOSTFILE=$(mktemp)
    
    # Hostfile header
    echo "host_name_bmcmac,bmc_IP,OS_IP,eth0_os_ip_mac,bmc_pwd,NodeXX,System_SN,bmc_mac,host_name_human,projname,rack_num" > "$TEMP_HOSTFILE"
    
    # Detect system serial if not provided
    if [[ -z "$SYSTEM_SN" ]]; then
        echo "Detecting system serial number from $OS_IP..."
        source "$SCRIPT_DIR/../common/get_sys_serial.sh" 2>/dev/null || source "$(dirname "$0")/../common/get_sys_serial.sh"
        SYSTEM_SN=$(get_sys_serial "$OS_IP")
        if [[ $? -ne 0 ]]; then
            echo "Warning: Failed to detect system serial number from $OS_IP, node will be skipped." >&2
            SYSTEM_SN=""
        else
            echo "Detected system serial: $SYSTEM_SN"
        fi
    fi
    
    # Add single node entry
    echo ",$BMC_IP,$OS_IP,,$BMC_PWD,N/A,$SYSTEM_SN,,$SYSTEM_SN,$RACK_NUM," >> "$TEMP_HOSTFILE"
    HOSTFILE="$TEMP_HOSTFILE"
else
    HOSTFILE="$1"
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FW_SW_DIR="$SCRIPT_DIR/../sanitycheck/01-fw-sw_checks"
BOM_DIR="$SCRIPT_DIR/../sanitycheck/02-bom_checks"
HEALTH_DIR="$SCRIPT_DIR/../sanitycheck/03-health_checks"
OUT_DIR="$SCRIPT_DIR/../racks/$RACK_NUM"
LIB_DIR="$SCRIPT_DIR/../common"

# Source helper functions
source "$LIB_DIR/colors.sh"
source "$LIB_DIR/get_sys_serial.sh"
source "$LIB_DIR/hostfile.sh"

# Trilsanitychk script for BOM validation
TRILSANITYCHK_SCRIPT="$BOM_DIR/01-trilsanitychk.sh"

# JSON parser script
BOM_PARSE_SCRIPT="$BOM_DIR/02-parse_json.sh"

# Component reference directory
COMPONENT_REF_DIR="$SCRIPT_DIR/../data"

# Health check scripts
PSU_SANCHECK_SCRIPT="$HEALTH_DIR/01-psu_health.sh"
VOLTAGE_SANCHECK_SCRIPT="$HEALTH_DIR/02-voltage_health.sh"
SEL_HEALTHCHECK_SCRIPT="$HEALTH_DIR/03-sel_find_active_errors.sh"

# FW/SW check scripts
FW_CHECK_SCRIPT="$FW_SW_DIR/01-firmwareinventoryinfo.sh"
SW_CHECK_SCRIPT="$FW_SW_DIR/02-software_capture.sh"

# Status tracking arrays
declare -A node_os_ip
declare -A node_bmc_ip
declare -A node_bmc_pwd
declare -A node_projname
declare -A node_host_name_human
declare -A node_number
declare -A fw_status
declare -A sw_status
declare -A bom_status
declare -A psu_status
declare -A voltage_status
declare -A sel_status
declare -A fw_failures
declare -A sw_failures
declare -A bom_failures
declare -A psu_failures
declare -A voltage_failures
declare -A sel_failures
declare -a NODE_ORDER
declare -A node_status_type  # "validated" or "skipped"
declare -A skipped_reasons
declare -A skipped_node_numbers

# Read hostfile and validate nodes
mapfile -t hosts < <(tail -n +2 "$HOSTFILE")

# Build filter array if NODE_FILTER is set
declare -a filter_nodes
if [[ -n "$NODE_FILTER" ]]; then
    IFS=',' read -ra filter_nodes <<< "$NODE_FILTER"
    echo "Filtering to nodes: ${filter_nodes[*]}"
fi

# First pass: Build array of selected nodes from hostfile
declare -a selected_nodes
declare -A selected_node_info

for line in "${hosts[@]}"; do
    IFS=, read -r host_name_bmcmac bmc_ip os_ip eth0_mac bmc_pwd node_label system_sn bmc_mac host_name_human projname rack_num <<< "$line"
    [[ -z "$os_ip" || -z "$projname" || -z "$bmc_ip" || -z "$bmc_pwd" ]] && continue

    # Apply node filter if specified
    node_in_filter "${node_label#N}" "${filter_nodes[@]}" || continue

    # Add to selected nodes array
    selected_nodes+=("$system_sn")

    # Store node info for later use
    selected_node_info["${system_sn}_os_ip"]="$os_ip"
    selected_node_info["${system_sn}_bmc_ip"]="$bmc_ip"
    selected_node_info["${system_sn}_bmc_pwd"]="$bmc_pwd"
    selected_node_info["${system_sn}_node_label"]="$node_label"
    selected_node_info["${system_sn}_projname"]="$projname"
    selected_node_info["${system_sn}_host_name_human"]="$host_name_human"
done

if [[ ${#selected_nodes[@]} -eq 0 ]]; then
    echo "${RED}No nodes selected for validation.${RESET}"
    exit 5
fi

echo "Selected ${#selected_nodes[@]} nodes for validation"

# Remove ssh keys only for selected nodes
for sn in "${selected_nodes[@]}"; do
    OS_IP="${selected_node_info[${sn}_os_ip]}"
    ssh-keygen -f ~/.ssh/known_hosts -R "$OS_IP" >/dev/null 2>&1
    ssh-keyscan -H "$OS_IP" >> ~/.ssh/known_hosts 2>/dev/null
done

# Validate nodes and build node list
echo "Validating nodes..."

# Parallel serial number validation
declare -A sn_pids
declare -A sn_tmpfiles
SN_VALIDATION_FAILED=false

# Start serial number checks in parallel for selected nodes only
for sn in "${selected_nodes[@]}"; do
    OS_IP="${selected_node_info[${sn}_os_ip]}"
    sn_tmpfiles["$sn"]=$(mktemp)
    (
        detected_sn=$(get_sys_serial "$OS_IP")
        sn_exit=$?
        echo "$detected_sn" > "${sn_tmpfiles[$sn]}"
        echo $sn_exit > "${sn_tmpfiles[$sn]}.exit"
    ) &
    sn_pids["$sn"]=$!
done

# Wait for all serial number checks; process results and build NODE_ORDER in one pass
NODE_ORDER=()

for sn in "${selected_nodes[@]}"; do
    wait ${sn_pids[$sn]}
    detected_sn=$(< "${sn_tmpfiles[$sn]}" tr -d '\n' 2>/dev/null)
    sn_exit=$(cat "${sn_tmpfiles[$sn]}.exit" 2>/dev/null)
    rm -f "${sn_tmpfiles[$sn]}" "${sn_tmpfiles[$sn]}.exit"
    [[ "${sn_exit:-1}" -ne 0 ]] && detected_sn=""
    
    # Add to NODE_ORDER
    NODE_ORDER+=("$sn")
    
    # Match detected SN against hostfile SN
    if [[ "$detected_sn" != "$sn" ]]; then
        SN_VALIDATION_FAILED=true
        node_status_type["$sn"]="skipped"
        if [[ -z "$detected_sn" ]]; then
            skipped_reasons["$sn"]="Failed to retrieve SN, node is offline or unreachable"
        elif [[ "$detected_sn" == "UNKNOWN" ]]; then
            skipped_reasons["$sn"]="Unknown SN (Put UNKNOWN as SN in hostfile to bypass this check)"
        else
            skipped_reasons["$sn"]="SN Mismatch (Expected: $sn, Got: $detected_sn)"
        fi
        skipped_node_numbers["$sn"]="${selected_node_info[${sn}_node_label]}"
        continue
    fi
    
    # Mark as validated and store node info
    node_status_type["$sn"]="validated"
    node_os_ip["$sn"]="${selected_node_info[${sn}_os_ip]}"
    node_bmc_ip["$sn"]="${selected_node_info[${sn}_bmc_ip]}"
    node_bmc_pwd["$sn"]="${selected_node_info[${sn}_bmc_pwd]}"
    node_projname["$sn"]="${selected_node_info[${sn}_projname]}"
    node_host_name_human["$sn"]="${selected_node_info[${sn}_host_name_human]}"
    node_number["$sn"]="${selected_node_info[${sn}_node_label]}"
    
    # Initialize status
    fw_status["$sn"]="PENDING"
    sw_status["$sn"]="PENDING"
    bom_status["$sn"]="PENDING"
    psu_status["$sn"]="PENDING"
    voltage_status["$sn"]="PENDING"
    sel_status["$sn"]="PENDING"
done

if [[ ${#NODE_ORDER[@]} -eq 0 ]]; then
    echo "${RED}No valid nodes found in hostfile.${RESET}"
    exit 5
fi

# ============================================================================================
# Temp-file status directory (one subdir per node, one file per check)
# ============================================================================================
STATUS_DIR=$(mktemp -d)
trap "rm -rf $STATUS_DIR ${TEMP_HOSTFILE:-}" EXIT

# Helper: read status for a check (returns PENDING if file missing)
read_status() {
    local sn="$1" check="$2"
    cat "$STATUS_DIR/$sn/$check" 2>/dev/null || echo "PENDING"
}

echo ""

# Function to get color based on status
get_status_color() {
    local status="$1"
    case "$status" in
        PASS)    echo "$GREEN"  ;;
        FAIL)    echo "$RED"    ;;
        WARN)    echo "$YELLOW" ;;
        RUNNING) echo "$YELLOW" ;;
        PENDING) echo "$BLUE"   ;;
        *)       echo "$RESET"  ;;
    esac
}

# Print the live status table. Clears the screen first.
# Optional first argument: section title printed above the table.
print_status_table() {
    local title="${1:-}"
    local output=""

    if [[ -n "$title" ]]; then
        output+="============================================================================================="$'\n'
        output+=$(printf "%43s\n" "$title")
        output+=$'\n'
        output+="============================================================================================="$'\n'
    fi

    output+="=============================================================================================="$'\n'
    output+="                                 Sanity Check Status"$'\n'
    output+="=============================================================================================="$'\n'
    output+=$(printf "%-5s | %-15s | %-7s | %-7s | %-7s | %-7s | %-7s | %-7s\n" \
        "Node#" "System SN" "FW" "SW" "BOM" "PSU" "Voltage" "SEL")
    output+=$'\n'
    output+="----------------------------------------------------------------------------------------------"$'\n'
    
    for i in "${!NODE_ORDER[@]}"; do
        sn="${NODE_ORDER[$i]}"
        
        if [[ "${node_status_type[$sn]}" == "skipped" ]]; then
            # Display skipped node
            node_num="${skipped_node_numbers[$sn]}"
            local skip_color="$RED"
            local skip_status="SKIPPED: ${skipped_reasons[$sn]}"
            output+=$(printf "%-5s | %-15s | ${skip_color}%-59s${RESET}\n" "$node_num" "$sn" "$skip_status")
            output+=$'\n'
        else
            # Display validated node
            node_num="${node_number[$sn]}"
            local fw_color=$(get_status_color "${fw_status[$sn]}")
            local sw_color=$(get_status_color "${sw_status[$sn]}")
            local bom_color=$(get_status_color "${bom_status[$sn]}")
            local psu_color=$(get_status_color "${psu_status[$sn]}")
            local volt_color=$(get_status_color "${voltage_status[$sn]}")
            local sel_color=$(get_status_color "${sel_status[$sn]}")

            output+=$(printf "%-5s | %-15s | ${fw_color}%-7s${RESET} | ${sw_color}%-7s${RESET} | ${bom_color}%-7s${RESET} | ${psu_color}%-7s${RESET} | ${volt_color}%-7s${RESET} | ${sel_color}%-7s${RESET}\n" \
                "$node_num" "$sn" \
                "${fw_status[$sn]}" "${sw_status[$sn]}" "${bom_status[$sn]}" \
                "${psu_status[$sn]}" "${voltage_status[$sn]}" "${sel_status[$sn]}")
            output+=$'\n'
        fi
    done
    
    output+="----------------------------------------------------------------------------------------------"$'\n'
    output+=$'\n'

    clear
    echo -n "$output"
}

# Show initial status
print_status_table

# Check if golden BOM exists (required by all nodes)
GOLDEN_BOM="${COMPONENT_REF_DIR}/bom_golden.json"
if [[ ! -f "$GOLDEN_BOM" ]]; then
    echo "${RED}Error: Golden BOM not found at $GOLDEN_BOM${RESET}"
    echo "Please capture a golden BOM first using option 'g' in the AIO menu."
    exit 1
fi

# ============================================================================================
# JSON / SSE helpers  (defined before run_node_all_checks so the subshell can use them)
# ============================================================================================
_json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\n'/\\n}"
    printf '%s' "$s"
}

_emit_check_json() {
    local name="$1" status="$2" failures="$3" log_path="$4" comma="$5"
    local esc_fail
    esc_fail=$(_json_escape "$failures")
    if [[ -n "$failures" ]]; then
        printf '    "%s": {"status": "%s", "log": "%s", "failures": "%s"}%s\n' \
            "$name" "$status" "$log_path" "$esc_fail" "$comma"
    else
        printf '    "%s": {"status": "%s", "log": "%s"}%s\n' \
            "$name" "$status" "$log_path" "$comma"
    fi
}

# Emit an SSE-friendly structured event to stdout.
sc_emit() {
    # ##SC:<node>:<serial>:<check>:<STATUS>:<timestamp_utc>:<log_path>
    local node="$1" sn="$2" check="$3" status="$4" log="${5:-}"
    echo "##SC:${node}:${sn}:${check}:${status}:$(date -u +%Y%m%dT%H%M%SZ):${log}"
}

# Write (or overwrite) the results JSON for a node.
# Reads _wj_* variables set by the caller (subshell-safe via variable inheritance).
_write_node_json() {
    local results_file="${OUT_DIR}/${_wj_sn}/101infosystem/results_${TIMESTAMP}.json"

    # Determine overall: IN_PROGRESS while any check is still pending/running
    local overall="IN_PROGRESS"
    local _all_done=true
    local _chk
    for _chk in "$_wj_fw_s" "$_wj_sw_s" "$_wj_bom_s" "$_wj_psu_s" "$_wj_volt_s" "$_wj_sel_s"; do
        [[ "$_chk" == "PENDING" || "$_chk" == "RUNNING" ]] && _all_done=false && break
    done
    if [[ "$_all_done" == true ]]; then
        overall="PASS"
        for _chk in "$_wj_fw_s" "$_wj_sw_s" "$_wj_bom_s" "$_wj_psu_s" "$_wj_volt_s" "$_wj_sel_s"; do
            [[ "$_chk" == "FAIL" ]] && overall="FAIL" && break
        done
        [[ "$overall" != "FAIL" && "$_wj_fw_s" == "WARN" ]] && overall="WARN"
    fi

    {
        echo "{"
        echo "  \"timestamp\": \"${TIMESTAMP}\","
        echo "  \"rack\": \"${RACK_NUM}\","
        echo "  \"sn\": \"${_wj_sn}\","
        echo "  \"node\": \"${_wj_node_num}\","
        echo "  \"os_ip\": \"${_wj_os_ip}\","
        echo "  \"bmc_ip\": \"${_wj_bmc_ip}\","
        echo "  \"overall\": \"${overall}\","
        echo "  \"checks\": {"
        _emit_check_json "fw"      "$_wj_fw_s"   "$_wj_fw_f"   "$_wj_fw_log"   ","
        _emit_check_json "sw"      "$_wj_sw_s"   "$_wj_sw_f"   "$_wj_sw_log"   ","
        _emit_check_json "bom"     "$_wj_bom_s"  "$_wj_bom_f"  "$_wj_bom_log"  ","
        _emit_check_json "psu"     "$_wj_psu_s"  "$_wj_psu_f"  "$_wj_psu_log"  ","
        _emit_check_json "voltage" "$_wj_volt_s" "$_wj_volt_f" "$_wj_volt_log" ","
        _emit_check_json "sel"     "$_wj_sel_s"  "$_wj_sel_f"  "$_wj_sel_log"  ""
        echo "  }"
        echo "}"
    } > "$results_file"
}

# ============================================================================================
# Per-node worker: runs all 6 checks sequentially, writes status to STATUS_DIR
# ============================================================================================
run_node_all_checks() {
    local sn="$1"
    local os_ip="$2"
    local bmc_ip="$3"
    local bmc_pwd="$4"
    local projname="$5"
    local node_dir="$STATUS_DIR/$sn"
    mkdir -p "$node_dir"

    # ---- Initialise subshell-global _wj_* state for JSON writes ----
    _wj_sn="$sn"
    _wj_node_num="${node_number[$sn]}"
    _wj_os_ip="$os_ip"
    _wj_bmc_ip="$bmc_ip"
    _wj_fw_s="PENDING"  _wj_fw_f=""
    _wj_sw_s="PENDING"  _wj_sw_f=""
    _wj_bom_s="PENDING" _wj_bom_f=""
    _wj_psu_s="PENDING" _wj_psu_f=""
    _wj_volt_s="PENDING" _wj_volt_f=""
    _wj_sel_s="PENDING" _wj_sel_f=""
    # Subshell-global exit code holders (not local — 'local var' resets $? to 0)
    bom_exit=0; bom_stderr=""
    _wj_fw_log="$sn/101infosystem/01-fw-sw_checks_${TIMESTAMP}/01-firmwareinventoryinfo_${TIMESTAMP}.hst"
    _wj_sw_log="$sn/101infosystem/01-fw-sw_checks_${TIMESTAMP}/02-software_capture_${TIMESTAMP}.csv"
    _wj_bom_log="$sn/101infosystem/02-bom_checks_${TIMESTAMP}/01-bom_chk_${TIMESTAMP}.json"
    _wj_psu_log="$sn/101infosystem/03-health_checks_${TIMESTAMP}/psu.csv"
    _wj_volt_log="$sn/101infosystem/03-health_checks_${TIMESTAMP}/voltage.csv"
    _wj_sel_log="$sn/101infosystem/03-health_checks_${TIMESTAMP}/sel.log"

    # Write initial JSON (all PENDING)
    mkdir -p "${OUT_DIR}/${sn}/101infosystem"
    _write_node_json

    # ---- FW check ----
    echo "RUNNING" > "$node_dir/fw"
    _wj_fw_s="RUNNING"; _write_node_json
    sc_emit "$_wj_node_num" "$sn" "fw" "RUNNING" "$_wj_fw_log"
    local fw_stderr
    fw_stderr=$(bash "$FW_CHECK_SCRIPT" "$OUT_DIR" "$sn" "$bmc_ip" "$bmc_pwd" "$TIMESTAMP" 2>&1 >/dev/null)
    local fw_exit=$?
    if [[ $fw_exit -eq 0 ]]; then
        if [[ -n "$fw_stderr" ]]; then
            echo "WARN"  > "$node_dir/fw"
            _wj_fw_f="$fw_stderr"
            _wj_fw_s="WARN"
            echo "$fw_stderr" > "$node_dir/fw.fail"
        else
            echo "PASS"  > "$node_dir/fw"
            _wj_fw_s="PASS"
        fi
    else
        _wj_fw_f="${fw_stderr:-FW check failed (exit: $fw_exit)}"
        _wj_fw_s="FAIL"
        echo "FAIL" > "$node_dir/fw"
        echo "${_wj_fw_f}" > "$node_dir/fw.fail"
    fi
    _write_node_json
    sc_emit "$_wj_node_num" "$sn" "fw" "$_wj_fw_s" "$_wj_fw_log"

    # ---- SW check ----
    echo "RUNNING" > "$node_dir/sw"
    _wj_sw_s="RUNNING"; _write_node_json
    sc_emit "$_wj_node_num" "$sn" "sw" "RUNNING" "$_wj_sw_log"
    local sw_stderr
    sw_stderr=$(bash "$SW_CHECK_SCRIPT" "$OUT_DIR" "$os_ip" "$TIMESTAMP" 2>&1 >/dev/null)
    local sw_exit=$?
    if [[ $sw_exit -eq 0 ]]; then
        echo "PASS" > "$node_dir/sw"
        _wj_sw_s="PASS"
    else
        _wj_sw_f="${sw_stderr:-SW check failed (exit: $sw_exit)}"
        _wj_sw_s="FAIL"
        echo "FAIL" > "$node_dir/sw"
        echo "${_wj_sw_f}" > "$node_dir/sw.fail"
    fi
    _write_node_json
    sc_emit "$_wj_node_num" "$sn" "sw" "$_wj_sw_s" "$_wj_sw_log"

    # ---- BOM check ----
    echo "RUNNING" > "$node_dir/bom"
    _wj_bom_s="RUNNING"; _write_node_json
    sc_emit "$_wj_node_num" "$sn" "bom" "RUNNING" "$_wj_bom_log"
    local bom_log_dir="${OUT_DIR}/${sn}/101infosystem/02-bom_checks_${TIMESTAMP}"
    mkdir -p "$bom_log_dir"
    local json_output="${bom_log_dir}/01-bom_chk_${TIMESTAMP}.json"
    bom_exit=0
    bom_stderr=""
    bom_stderr=$(bash "$TRILSANITYCHK_SCRIPT" --host "$os_ip" --bmc-pwd "$bmc_pwd" \
        --export "$json_output" --compare-bom "$GOLDEN_BOM" 2>&1 >/dev/null)
    bom_exit=$?
    # Parse JSON regardless of exit (JSON may have been written before a failure)
    if [[ -f "$json_output" ]]; then
        bash "$BOM_PARSE_SCRIPT" "$json_output" 2>/dev/null
    fi
    if [[ $bom_exit -eq 0 ]]; then
        echo "PASS" > "$node_dir/bom"
        _wj_bom_s="PASS"
    else
        _wj_bom_f="${bom_stderr:-BOM check failed (exit: $bom_exit)}"
        _wj_bom_s="FAIL"
        echo "FAIL" > "$node_dir/bom"
        echo "${_wj_bom_f}" > "$node_dir/bom.fail"
    fi
    _write_node_json
    sc_emit "$_wj_node_num" "$sn" "bom" "$_wj_bom_s" "$_wj_bom_log"

    # ---- Health checks (PSU / Voltage / SEL) ----
    local health_dir="${OUT_DIR}/${sn}/101infosystem/03-health_checks_${TIMESTAMP}"
    mkdir -p "$health_dir"

    # Check BMC reachability once for the three health checks
    if ! timeout 5 bash -c "curl -s -k -u ADMIN:$bmc_pwd https://$bmc_ip/redfish/v1/Chassis/1/Power" >/dev/null 2>&1; then
        local bmc_msg="BMC unreachable at $bmc_ip"
        for check in psu voltage sel; do
            echo "FAIL" > "$node_dir/$check"
            echo "$bmc_msg" > "$node_dir/${check}.fail"
        done
        _wj_psu_s="FAIL"  _wj_psu_f="$bmc_msg"
        _wj_volt_s="FAIL" _wj_volt_f="$bmc_msg"
        _wj_sel_s="FAIL"  _wj_sel_f="$bmc_msg"
        _write_node_json
        sc_emit "$_wj_node_num" "$sn" "psu"     "FAIL" "$_wj_psu_log"
        sc_emit "$_wj_node_num" "$sn" "voltage" "FAIL" "$_wj_volt_log"
        sc_emit "$_wj_node_num" "$sn" "sel"     "FAIL" "$_wj_sel_log"
        return
    fi

    # PSU
    echo "RUNNING" > "$node_dir/psu"
    _wj_psu_s="RUNNING"; _write_node_json
    sc_emit "$_wj_node_num" "$sn" "psu" "RUNNING" "$_wj_psu_log"
    local psu_stderr
    psu_stderr=$(bash "$PSU_SANCHECK_SCRIPT" "$bmc_ip" "$bmc_pwd" "$health_dir/psu.csv" 2>&1 >/dev/null)
    local psu_exit=$?
    if [[ $psu_exit -eq 0 ]]; then
        echo "PASS" > "$node_dir/psu"
        _wj_psu_s="PASS"
    else
        _wj_psu_f="${psu_stderr:-PSU check failed (exit: $psu_exit)}"
        _wj_psu_s="FAIL"
        echo "FAIL" > "$node_dir/psu"
        echo "${_wj_psu_f}" > "$node_dir/psu.fail"
    fi
    _write_node_json
    sc_emit "$_wj_node_num" "$sn" "psu" "$_wj_psu_s" "$_wj_psu_log"

    # Voltage
    echo "RUNNING" > "$node_dir/voltage"
    _wj_volt_s="RUNNING"; _write_node_json
    sc_emit "$_wj_node_num" "$sn" "voltage" "RUNNING" "$_wj_volt_log"
    local volt_stderr
    volt_stderr=$(bash "$VOLTAGE_SANCHECK_SCRIPT" "$bmc_ip" "$bmc_pwd" "$health_dir/voltage.csv" 2>&1 >/dev/null)
    local volt_exit=$?
    if [[ $volt_exit -eq 0 ]]; then
        echo "PASS" > "$node_dir/voltage"
        _wj_volt_s="PASS"
    else
        _wj_volt_f="${volt_stderr:-Voltage check failed (exit: $volt_exit)}"
        _wj_volt_s="FAIL"
        echo "FAIL" > "$node_dir/voltage"
        echo "${_wj_volt_f}" > "$node_dir/voltage.fail"
    fi
    _write_node_json
    sc_emit "$_wj_node_num" "$sn" "voltage" "$_wj_volt_s" "$_wj_volt_log"

    # SEL
    echo "RUNNING" > "$node_dir/sel"
    _wj_sel_s="RUNNING"; _write_node_json
    sc_emit "$_wj_node_num" "$sn" "sel" "RUNNING" "$_wj_sel_log"
    local sel_stderr
    sel_stderr=$(bash "$SEL_HEALTHCHECK_SCRIPT" "$bmc_ip" "$bmc_pwd" "$health_dir/sel.log" 2>&1 >/dev/null)
    local sel_exit=$?
    if [[ $sel_exit -eq 0 ]]; then
        echo "PASS" > "$node_dir/sel"
        _wj_sel_s="PASS"
    else
        _wj_sel_f="${sel_stderr:-SEL check failed (exit: $sel_exit)}"
        _wj_sel_s="FAIL"
        echo "FAIL" > "$node_dir/sel"
        echo "${_wj_sel_f}" > "$node_dir/sel.fail"
    fi
    _write_node_json
    sc_emit "$_wj_node_num" "$sn" "sel" "$_wj_sel_s" "$_wj_sel_log"
}

# ============================================================================================
# Launch one background process per validated node
# ============================================================================================
declare -A node_pids

for sn in "${NODE_ORDER[@]}"; do
    [[ "${node_status_type[$sn]}" == "skipped" ]] && continue

    run_node_all_checks \
        "$sn" \
        "${node_os_ip[$sn]}" \
        "${node_bmc_ip[$sn]}" \
        "${node_bmc_pwd[$sn]}" \
        "${node_projname[$sn]}" &
    node_pids["$sn"]=$!
done

# ============================================================================================
# Polling loop: refresh display until all node processes have finished
# ============================================================================================
_read_statuses_from_files() {
    for sn in "${NODE_ORDER[@]}"; do
        [[ "${node_status_type[$sn]}" == "skipped" ]] && continue
        fw_status["$sn"]=$(read_status "$sn" fw)
        sw_status["$sn"]=$(read_status "$sn" sw)
        bom_status["$sn"]=$(read_status "$sn" bom)
        psu_status["$sn"]=$(read_status "$sn" psu)
        voltage_status["$sn"]=$(read_status "$sn" voltage)
        sel_status["$sn"]=$(read_status "$sn" sel)
    done
}

_all_workers_done() {
    local sn
    for sn in "${NODE_ORDER[@]}"; do
        [[ "${node_status_type[$sn]}" == "skipped" ]] && continue
        kill -0 "${node_pids[$sn]}" 2>/dev/null && return 1
    done
    return 0
}

LAST_SNAPSHOT=""
while true; do
    _read_statuses_from_files

    # Build snapshot string to detect any state change
    current_snapshot=""
    for sn in "${NODE_ORDER[@]}"; do
        [[ "${node_status_type[$sn]}" == "skipped" ]] && continue
        current_snapshot+="${sn}:${fw_status[$sn]},${sw_status[$sn]},${bom_status[$sn]},${psu_status[$sn]},${voltage_status[$sn]},${sel_status[$sn]};"
    done

    if [[ "$current_snapshot" != "$LAST_SNAPSHOT" ]]; then
        print_status_table
        LAST_SNAPSHOT="$current_snapshot"
    fi

    _all_workers_done && break
    sleep 0.5
done

# Wait for all background processes to finish and do one final read
for sn in "${NODE_ORDER[@]}"; do
    [[ "${node_status_type[$sn]}" == "skipped" ]] && continue
    wait "${node_pids[$sn]}" 2>/dev/null
done
_read_statuses_from_files

# Load failure details into arrays for the summary section
for sn in "${NODE_ORDER[@]}"; do
    [[ "${node_status_type[$sn]}" == "skipped" ]] && continue
    fw_failures["$sn"]=$(cat "$STATUS_DIR/$sn/fw.fail" 2>/dev/null)
    sw_failures["$sn"]=$(cat "$STATUS_DIR/$sn/sw.fail" 2>/dev/null)
    bom_failures["$sn"]=$(cat "$STATUS_DIR/$sn/bom.fail" 2>/dev/null)
    psu_failures["$sn"]=$(cat "$STATUS_DIR/$sn/psu.fail" 2>/dev/null)
    voltage_failures["$sn"]=$(cat "$STATUS_DIR/$sn/voltage.fail" 2>/dev/null)
    sel_failures["$sn"]=$(cat "$STATUS_DIR/$sn/sel.fail" 2>/dev/null)
done

# ============================================================================================
# Log System Info After Sanity Check
# ============================================================================================
echo ""
echo "Logging system info after sanity check..."
for sn in "${NODE_ORDER[@]}"; do
    [[ "${node_status_type[$sn]}" == "skipped" ]] && continue
    echo "Logging SANITY system info on ${node_host_name_human[$sn]} (${node_os_ip[$sn]})"
done
echo ""

# ============================================================================================
# Final Summary
# ============================================================================================
print_status_table "Final Summary"

_print_fail_lines() {
    local label="$1" text="$2"
    [[ -z "$text" ]] && return
    echo "  --------------------------------------------------------------------------------------------"
    local IFS=$'\n'
    local lines=( $text )
    printf "  ${RED}%-15s${RESET}: %s\n" "$label" "${lines[0]}"
    for ((i=1; i<${#lines[@]}; i++)); do
        printf "  %-15s: %s\n" "" "${lines[$i]}"
    done
}

# Calculate final results
PASS_COUNT=0
FAIL_COUNT=0
SKIPPED_COUNT=0

for sn in "${NODE_ORDER[@]}"; do
    if [[ "${node_status_type[$sn]}" == "skipped" ]]; then
        ((SKIPPED_COUNT++))
    elif [[ "${fw_status[$sn]}" == "PASS" && "${sw_status[$sn]}" == "PASS" && "${bom_status[$sn]}" == "PASS" && \
          "${psu_status[$sn]}" == "PASS" && "${voltage_status[$sn]}" == "PASS" && "${sel_status[$sn]}" == "PASS" ]]; then
        ((PASS_COUNT++))
    else
        ((FAIL_COUNT++))
    fi
done

# Add skipped nodes to fail count
FAIL_COUNT=$((FAIL_COUNT + SKIPPED_COUNT))
TOTAL_NODES=${#NODE_ORDER[@]}
if [[ $FAIL_COUNT -eq 0 ]]; then
    if [[ "$SN_VALIDATION_FAILED" == "true" ]]; then
        EXIT_CODE=5
    else
        EXIT_CODE=0
    fi
else
    if [[ "$SN_VALIDATION_FAILED" == "true" ]]; then
        EXIT_CODE=5
    else
        EXIT_CODE=1
    fi
fi

if [[ $FAIL_COUNT -eq 0 ]]; then
    echo "Final Result: ${GREEN}All $PASS_COUNT/$TOTAL_NODES nodes passed all checks.${RESET}"
    [[ "$SN_VALIDATION_FAILED" == "true" ]] && echo "${YELLOW}Warning: Some nodes were skipped due to SN validation failures.${RESET}"
else
    echo "Final Result: ${RED}$FAIL_COUNT/$TOTAL_NODES nodes failed one or more checks.${RESET}"
    [[ "$SN_VALIDATION_FAILED" == "true" ]] && echo "${YELLOW}Warning: Some nodes were also skipped due to SN validation failures.${RESET}"

    for sn in "${NODE_ORDER[@]}"; do
        has_failures=false
        [[ "${fw_status[$sn]}"      == "FAIL" || "${fw_status[$sn]}" == "WARN" ]] && has_failures=true
        [[ "${sw_status[$sn]}"      == "FAIL" ]] && has_failures=true
        [[ "${bom_status[$sn]}"     == "FAIL" ]] && has_failures=true
        [[ "${psu_status[$sn]}"     == "FAIL" ]] && has_failures=true
        [[ "${voltage_status[$sn]}" == "FAIL" ]] && has_failures=true
        [[ "${sel_status[$sn]}"     == "FAIL" ]] && has_failures=true

        if [[ "$has_failures" == "true" ]]; then
            echo ""
            echo "${RED}Node: $sn${RESET}"
            printf "  %-15s: %s\n" "OS IP"        "${node_os_ip[$sn]}"
            printf "  %-15s: %s\n" "BMC IP"       "${node_bmc_ip[$sn]}"
            printf "  %-15s: %s\n" "BMC Password" "${node_bmc_pwd[$sn]}"

            fw_label="FW"
            [[ "${fw_status[$sn]}" == "WARN" ]] && fw_label="FW (WARN)"
            [[ "${fw_status[$sn]}"      == "FAIL" || "${fw_status[$sn]}" == "WARN" ]] \
                && _print_fail_lines "$fw_label"  "${fw_failures[$sn]}"
            [[ "${sw_status[$sn]}"      == "FAIL" ]] && _print_fail_lines "SW"      "${sw_failures[$sn]}"
            [[ "${bom_status[$sn]}"     == "FAIL" ]] && _print_fail_lines "BOM"     "${bom_failures[$sn]}"
            [[ "${psu_status[$sn]}"     == "FAIL" ]] && _print_fail_lines "PSU"     "${psu_failures[$sn]}"
            [[ "${voltage_status[$sn]}" == "FAIL" ]] && _print_fail_lines "Voltage" "${voltage_failures[$sn]}"
            [[ "${sel_status[$sn]}"     == "FAIL" ]] && _print_fail_lines "SEL"     "${sel_failures[$sn]}"
        fi
    done
    echo ""
    echo "=============================================================================================="
fi
echo ""

# Write per-node results to result file if requested
if [[ -n "$RESULT_FILE" ]]; then
    : > "$RESULT_FILE"
    for sn in "${NODE_ORDER[@]}"; do
        # Determine node label (prefer validated node_number, fall back to skipped_node_numbers)
        local_label="${node_number[$sn]:-${skipped_node_numbers[$sn]}}"
        # Normalise to N<num> (strip leading chars before the trailing digits)
        local_num=$(echo "$local_label" | grep -oE '[0-9]+$')
        [[ -z "$local_num" ]] && continue

        if [[ "${node_status_type[$sn]}" == "skipped" ]]; then
            echo "N${local_num}=FAIL" >> "$RESULT_FILE"
        elif [[ "${fw_status[$sn]}"      == "PASS" &&
                "${sw_status[$sn]}"      == "PASS" &&
                "${bom_status[$sn]}"     == "PASS" &&
                "${psu_status[$sn]}"     == "PASS" &&
                "${voltage_status[$sn]}" == "PASS" &&
                "${sel_status[$sn]}"     == "PASS" ]]; then
            echo "N${local_num}=PASS" >> "$RESULT_FILE"
        else
            echo "N${local_num}=FAIL" >> "$RESULT_FILE"
        fi
    done
fi

# Results JSONs were written in real-time by each node worker.
# Write skipped-node JSONs now (workers never ran for them).
for sn in "${NODE_ORDER[@]}"; do
    [[ "${node_status_type[$sn]}" != "skipped" ]] && continue
    node_infosys_dir="${OUT_DIR}/${sn}/101infosystem"
    mkdir -p "$node_infosys_dir"
    results_file="${node_infosys_dir}/results_${TIMESTAMP}.json"
    node_num="${skipped_node_numbers[$sn]}"
    esc_reason=$(_json_escape "${skipped_reasons[$sn]}")
    {
        echo "{"
        echo "  \"timestamp\": \"$TIMESTAMP\","
        echo "  \"rack\": \"$RACK_NUM\","
        echo "  \"sn\": \"$sn\","
        echo "  \"node\": \"$node_num\","
        echo "  \"overall\": \"SKIPPED\","
        echo "  \"skip_reason\": \"$esc_reason\""
        echo "}"
    } > "$results_file"
    sc_emit "$node_num" "$sn" "all" "SKIPPED" ""
done

