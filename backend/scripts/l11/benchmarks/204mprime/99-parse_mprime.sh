#!/bin/bash
# mprime benchmark parser
# Standalone parser script that outputs CSV section for this benchmark
# Usage: 99-parse_mprime.sh <benchmark_dir1> [benchmark_dir2 ...]

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
    
    # Parse benchmark-specific data
    last_line=$(grep "Torture Test completed" "$latest_log" | tail -n1)
    tests_completed=$(echo "$last_line" | sed -E 's/.*Torture Test completed ([0-9]+) tests.*/\1/')
    errors=$(echo "$last_line" | sed -E 's/.*- ([0-9]+) errors, ([0-9]+) warnings.*/\1/')
    warnings=$(echo "$last_line" | sed -E 's/.*- ([0-9]+) errors, ([0-9]+) warnings.*/\2/')
    
    # Determine benchmark-specific status
    [ "${errors:-1}" -eq 0 ] && bench_status="PASS" || bench_status="FAIL"
    
    # Check exit code (overrides benchmark status if non-zero)
    status=$(check_exit_code "$latest_log" "$bench_status")
    
    cstatus=$([ "$status" == "PASS" ] && echo -e "${GREEN}PASS${RESET}" || echo -e "${RED}FAIL${RESET}")
    
    # Console output (to stderr)
    printf "[ %-*s | %-*s ]  %-*b | Tests Completed: %s | Errors: %s | Warnings: %s\n" \
        "$RACK_WIDTH" "$hostname" "$NODE_BENCH_WIDTH" "$sys_sn - MPrime" "$STATUS_WIDTH" "$cstatus" \
        "${tests_completed:-0}" "${errors:-N/A}" "${warnings:-N/A}" >&2
    
    # CSV output (to stdout)
    echo "$latest_log,$sys_sn,$status,$time_start,$time_end,$duration,${tests_completed:-0},${errors:-N/A},${warnings:-N/A}"
done)

if [[ -n "$ROWS" ]]; then
    echo ""
    echo "${BENCHMARK_TITLE}"
    echo "Log,SN,Result,Time Started,Time Completed,Duration,Tests,Error,Warning"
    echo "$ROWS"
fi
