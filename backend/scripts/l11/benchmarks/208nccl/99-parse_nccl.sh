#!/bin/bash
# NCCL benchmark parser
# Standalone parser script that outputs CSV section for this benchmark
# Usage: 99-parse_nccl.sh <benchmark_dir1> [benchmark_dir2 ...]

# Get script's directory to find common.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source common utilities
source "$PROJECT_ROOT/common/parse_common.sh"
source "$PROJECT_ROOT/common/check_exit_code.sh"

# Benchmark metadata
BENCH_INFO="$SCRIPT_DIR/bench_info.json"
BENCHMARK_TITLE=$(jq -r '.benchmark_title[0]' "$BENCH_INFO")

# Each argument is the direct path to a node's benchmark directory

# Helper function to parse NCCL log file
# Usage: parse_nccl_log <log_file>
# Returns: Sets nccl_out_of_place, nccl_in_place, nccl_status, nccl_num_nodes, and nccl_peer_sns
parse_nccl_log() {
    local log_file="$1"
    
    # Clear and declare arrays
    unset nccl_out_of_place
    unset nccl_in_place
    declare -gA nccl_out_of_place
    declare -gA nccl_in_place
    
    # Extract number of nodes and peer SNs from header
    nccl_num_nodes=""
    nccl_peer_sns=""
    
    while IFS= read -r line; do
        if [[ "$line" =~ ^Num\ Nodes[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
            nccl_num_nodes="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^Peer\ SN[[:space:]]*:[[:space:]]*(.+) ]]; then
            nccl_peer_sns="${BASH_REMATCH[1]}"
        fi
        # Stop reading after the header section
        [[ "$line" =~ ^-{50,} ]] && break
    done < "$log_file"
    
    # If num_nodes not found in header, count "device  0" in first test as fallback
    if [[ -z "$nccl_num_nodes" ]]; then
        local in_first_test=0
        local device_0_count=0
        while IFS= read -r line; do
            if [[ "$line" =~ ^#\ Using\ devices ]]; then
                in_first_test=1
                continue
            fi
            if [[ $in_first_test -eq 1 && "$line" =~ device[[:space:]]+0[[:space:]] ]]; then
                ((device_0_count++))
            fi
            if [[ $in_first_test -eq 1 && "$line" =~ ^#[[:space:]]*$ ]]; then
                break
            fi
        done < "$log_file"
        nccl_num_nodes="$device_0_count"
    fi
    
    # Parse collective test results
    for collective in all_reduce_perf all_gather_perf alltoall_perf; do
        local last_line=""
        local found=0
        while IFS= read -r line; do
            if [[ "$line" =~ ^#\ Collective\ test\ starting:\ $collective ]]; then
                found=1
                continue
            fi
            if [[ $found -eq 1 ]]; then
                if [[ "$line" =~ ^[[:space:]]*[0-9]+ ]]; then
                    last_line="$line"
                elif [[ "$line" =~ ^#\ Collective\ test\ concluded: ]]; then
                    break
                fi
            fi
        done < "$log_file"
        
        if [[ -n "$last_line" ]]; then
            nccl_out_of_place[$collective]=$(echo "$last_line" | awk '{print $8}')
            nccl_in_place[$collective]=$(echo "$last_line" | awk '{print $12}')
        else
            nccl_out_of_place[$collective]=""
            nccl_in_place[$collective]=""
        fi
    done
    
    # Determine status based on exit code only
    nccl_status=$(check_exit_code "$log_file" "PASS")
}

# Declare associative array to group results by number of nodes
declare -A results_by_node_count
declare -A found_node_counts

# Collect all NCCL results grouped by number of nodes
for BENCHMARK_DIR in "$@"; do
    # Extract metadata
    if [[ "$BENCHMARK_DIR" == *@* ]]; then
        HOSTNAME="${BENCHMARK_DIR%%@*}"
        BENCHMARK_DIR="${BENCHMARK_DIR#*@}"
    else
        HOSTNAME="N/A"
    fi
    SYS_SN=$(basename "$(dirname "$BENCHMARK_DIR")")

    [[ -d "$BENCHMARK_DIR" ]] || continue

    # Find all NCCL logs in the directory (exclude script_logs subdirectory)
    shopt -s nullglob
    LOG_FILES=()

    # Look for main log files only (skip script_logs subdirectory) and sort by modification time (newest first)
    while IFS= read -r log_file; do
        LOG_FILES+=("$log_file")
    done < <(find "$BENCHMARK_DIR" -maxdepth 1 -type f -name "*.log" -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)

    for log_file in "${LOG_FILES[@]}"; do
        # Extract time metadata
        extract_common_metadata "$log_file"

        # Parse NCCL data
        parse_nccl_log "$log_file"
        
        # Skip if no valid data
        [[ -z "$nccl_num_nodes" ]] && continue
        
        # Skip if we already have a result for this node count and this node
        NODE_COUNT_KEY="${SYS_SN}_${nccl_num_nodes}"
        if [[ -n "${found_node_counts[$NODE_COUNT_KEY]}" ]]; then
            continue
        fi
        
        # Mark this node count as found for this node
        found_node_counts[$NODE_COUNT_KEY]=1
        
        # Build console output dynamically
        CONSOLE_PARTS=""
        if [[ -n "${nccl_out_of_place[all_reduce_perf]}" && -n "${nccl_in_place[all_reduce_perf]}" ]]; then
            CONSOLE_PARTS+=" | AR OOP/IP: ${nccl_out_of_place[all_reduce_perf]}/${nccl_in_place[all_reduce_perf]}"
        fi
        if [[ -n "${nccl_out_of_place[all_gather_perf]}" && -n "${nccl_in_place[all_gather_perf]}" ]]; then
            CONSOLE_PARTS+=" | AG OOP/IP: ${nccl_out_of_place[all_gather_perf]}/${nccl_in_place[all_gather_perf]}"
        fi
        if [[ -n "${nccl_out_of_place[alltoall_perf]}" && -n "${nccl_in_place[alltoall_perf]}" ]]; then
            CONSOLE_PARTS+=" | AA OOP/IP: ${nccl_out_of_place[alltoall_perf]}/${nccl_in_place[alltoall_perf]}"
        fi
        
        # Determine section label
        SECTION_LABEL="NCCL"
        if [[ "$nccl_num_nodes" -gt 1 ]]; then
            SECTION_LABEL="${nccl_num_nodes}-Node NCCL"
        fi
        
        # Console output (to stderr)
        CSTATUS=$([ "$nccl_status" == "PASS" ] && echo -e "${GREEN}PASS${RESET}" || echo -e "${RED}FAIL${RESET}")
        printf "[ %-*s | %-*s ]  %-*b%s\n" \
            "$RACK_WIDTH" "$HOSTNAME" "$NODE_BENCH_WIDTH" "$SYS_SN - $SECTION_LABEL" "$STATUS_WIDTH" "$CSTATUS" "$CONSOLE_PARTS" >&2
        
        # Format peer SNs: replace commas with pipes, remove spaces after commas
        PEER_SNS_FORMATTED=$(echo "$nccl_peer_sns" | sed 's/, */|/g')
        
        # Store CSV data grouped by node count
        CSV_LINE="$log_file,$SYS_SN,$nccl_status,$time_start,$time_end,$duration,$nccl_num_nodes,$PEER_SNS_FORMATTED,${nccl_out_of_place[all_reduce_perf]},${nccl_in_place[all_reduce_perf]},${nccl_out_of_place[all_gather_perf]},${nccl_in_place[all_gather_perf]},${nccl_out_of_place[alltoall_perf]},${nccl_in_place[alltoall_perf]}"
        
        if [[ -z "${results_by_node_count[$nccl_num_nodes]}" ]]; then
            results_by_node_count[$nccl_num_nodes]="$CSV_LINE"
        else
            results_by_node_count[$nccl_num_nodes]+=$'\n'"$CSV_LINE"
        fi
    done
done

# Output sections dynamically based on node counts found
for node_count in $(echo "${!results_by_node_count[@]}" | tr ' ' '\n' | sort -n); do
    echo ""
    if [[ "$node_count" -eq 1 ]]; then
        echo "${BENCHMARK_TITLE}"
    else
        echo "${node_count}-Node ${BENCHMARK_TITLE}"
    fi
    echo "Log,SN,Result,Time Started,Time Completed,Duration,Num Nodes,Peer SNs,All Reduce(out-of-place)GB/s,All Reduce(in-place)GB/s,All Gather(out-of-place)GB/s,All Gather(in-place)GB/s,All To All(out-of-place)GB/s,All To All(in-place)GB/s"
    echo "${results_by_node_count[$node_count]}"
done
