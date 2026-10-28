#!/bin/bash
# DCGM benchmark parser
# Standalone parser script that outputs CSV section for this benchmark
# Usage: 99-parse_dcgm.sh <benchmark_dir1> [benchmark_dir2 ...]

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

# Process each node
ROWS=$(for benchmark_dir in "$@"; do
    # Strip optional hostname prefix
    if [[ "$benchmark_dir" == *@* ]]; then
        hostname="${benchmark_dir%%@*}"
        benchmark_dir="${benchmark_dir#*@}"
    else
        hostname="N/A"
    fi

    [[ -d "$benchmark_dir" ]] || continue

    # Find latest log
    latest_log=$(find_latest_log "$benchmark_dir" ".*" "^script")
    if [[ -z "$latest_log" || ! -f "$latest_log" ]]; then
        continue
    fi

    sys_sn=$(basename "$(dirname "$benchmark_dir")")
    extract_common_metadata "$latest_log"
    
    # Parse overall status: only treat diagnostic sections as pass/fail
    bench_status="PASS"
    fail_sections=()
    fail_gpus=()
    eud_present="No"
    
    while IFS= read -r line; do
        if [[ "$line" =~ \| ]]; then
            section=$(echo "$line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')
            result=$(echo "$line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); print $3}')
            
            # Check for eud section
            if [[ "$section" == "eud" ]]; then
                eud_present="Yes"
            fi
            
            # Only treat diagnostic sections as pass/fail
            if [[ "$section" =~ ^(software|memory|diagnostic|nvbandwidth|pulse_test|eud|pcie|memtest|memory_bandwidth|targeted_stress|targeted_power)$ ]]; then
                if [[ "$result" != "Pass" ]]; then
                    bench_status="FAIL"
                    fail_sections+=("$section: $result")
                fi
            fi
        fi
    done < <(awk '/\+---------------------------\+/{flag=1;next} /\+---------------------------\+/{flag=0} flag' "$latest_log")
    
    # Check exit code (overrides benchmark status if non-zero)
    status=$(check_exit_code "$latest_log" "$bench_status")
    
    # Per-GPU results: count how many GPUs failed
    gpu_fail_count=0
    gpu_total_count=0
    while IFS= read -r line; do
        if [[ "$line" =~ GPU[0-9]+: ]]; then
            gpu_total_count=$((gpu_total_count+1))
            if [[ "$line" != *"Pass"* ]]; then
                gpu_fail_count=$((gpu_fail_count+1))
                fail_gpus+=("$line")
            fi
        fi
    done < <(awk '/\+---------------------------\+/{flag=1;next} /\+---------------------------\+/{flag=0} flag' "$latest_log")
    
    # Console output (to stderr)
    cstatus=$([ "$status" == "PASS" ] && echo -e "${GREEN}PASS${RESET}" || echo -e "${RED}FAIL${RESET}")
    printf "[ %-*s | %-*s ]  %-*b | Tests: %d/%d Passed | EUD: %s\n" \
        "$RACK_WIDTH" "$hostname" "$NODE_BENCH_WIDTH" "$sys_sn - DCGM" "$STATUS_WIDTH" "$cstatus" \
        $((gpu_total_count-gpu_fail_count)) "$gpu_total_count" "$eud_present" >&2
    
    if [ "$status" != "PASS" ]; then
        echo "  Failed sections: ${fail_sections[*]}" >&2
        if [ "$gpu_fail_count" -gt 0 ]; then
            echo "  Failed GPUs:" >&2
            printf "    %s\n" "${fail_gpus[@]}" >&2
        fi
    fi
    
    # CSV output (to stdout)
    echo "$latest_log,$sys_sn,$status,$time_start,$time_end,$duration,$gpu_total_count,$((gpu_total_count-gpu_fail_count)),$gpu_fail_count,$eud_present"
done)

if [[ -n "$ROWS" ]]; then
    echo ""
    echo "${BENCHMARK_TITLE}"
    echo "Log,SN,Result,Time Started,Time Completed,Duration,Total Tests, Tests Passed,Tests Failed,EUD"
    echo "$ROWS"
fi
