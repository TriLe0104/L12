#!/bin/bash
# common/hostfile.sh — Shared hostfile parsing utilities.
# Source this file; do not execute directly.
#
# Provides:
#   node_in_filter NODE_NUM [FILTER_NODE...]
#     Returns 0 (include) if NODE_NUM is in the filter list, or if the list is
#     empty (no filter = include all). Returns 1 (exclude) otherwise.
#
#   parse_hostfile_line LINE
#     Parses one CSV data line and exports variables:
#       hf_host_bmcmac, hf_bmc_ip, hf_os_ip, hf_eth0_mac, hf_bmc_pwd,
#       hf_node_label, hf_system_sn, hf_bmc_mac, hf_host_name_human,
#       hf_projname, hf_rack_num, hf_node_num
#     Returns 1 if mandatory fields (os_ip, bmc_ip) are empty.

# node_in_filter NODE_NUM [FILTER_NODE...]
# Returns 0 if included, 1 if excluded.
node_in_filter() {
    local node_num="$1"
    shift
    local filter_nodes=("$@")

    # Empty filter → include everything
    [[ ${#filter_nodes[@]} -eq 0 ]] && return 0

    local f
    for f in "${filter_nodes[@]}"; do
        [[ "$node_num" == "$f" ]] && return 0
    done
    return 1
}

# parse_hostfile_line LINE
# Strips CRLF, splits on commas, exports hf_* variables.
# Returns 1 if mandatory fields are empty.
parse_hostfile_line() {
    local line
    line=$(printf '%s' "$1" | tr -d '\r')

    IFS=, read -r \
        hf_host_bmcmac hf_bmc_ip hf_os_ip hf_eth0_mac hf_bmc_pwd \
        hf_node_label hf_system_sn hf_bmc_mac hf_host_name_human \
        hf_projname hf_rack_num <<< "$line"

    # Strip any residual CR from each field
    hf_bmc_ip="${hf_bmc_ip//$'\r'/}"
    hf_os_ip="${hf_os_ip//$'\r'/}"
    hf_bmc_pwd="${hf_bmc_pwd//$'\r'/}"
    hf_node_label="${hf_node_label//$'\r'/}"
    hf_system_sn="${hf_system_sn//$'\r'/}"
    hf_rack_num="${hf_rack_num//$'\r'/}"
    hf_projname="${hf_projname//$'\r'/}"

    # Derive node number by stripping leading "N"
    hf_node_num="${hf_node_label#N}"

    # Require at least bmc_ip and os_ip
    [[ -z "$hf_bmc_ip" || -z "$hf_os_ip" ]] && return 1
    return 0
}

# resolve_rack_hostfile RACK_NUM
# Prints the path to the first hostfile*.csv found under racks/RACK_NUM/.
# Resolves racks/ relative to this script's location (common/../racks/).
# Returns 1 if none found.
resolve_rack_hostfile() {
    local rack_num="$1"
    local _self_dir
    _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local found
    found=$(ls "${_self_dir}/../racks/${rack_num}/hostfile"*.csv 2>/dev/null | head -1)
    [[ -z "$found" ]] && return 1
    printf '%s\n' "$found"
}
