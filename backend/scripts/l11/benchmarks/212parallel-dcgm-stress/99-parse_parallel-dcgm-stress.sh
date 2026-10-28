#!/bin/bash
# Parallel DCGM + stress-ng benchmark parser
# Standalone parser script that outputs CSV sections for both benchmarks
# Usage: 99-parse_parallel-dcgm-stress.sh <benchmark_dir1> [benchmark_dir2 ...]

# Get script's directory to find common.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source common utilities
source "$PROJECT_ROOT/common/parse_common.sh"
source "$PROJECT_ROOT/common/check_exit_code.sh"

# Benchmark metadata
BENCH_INFO="$SCRIPT_DIR/bench_info.json"
DCGM_TITLE=$(jq -r '.benchmark_title[0]' "$BENCH_INFO")
STRESS_TITLE=$(jq -r '.benchmark_title[1]' "$BENCH_INFO")

# Each argument is the direct path to a node's benchmark directory

# ========== DCGM Section ==========
# Process each node for DCGM
DCGM_ROWS=$(for benchmark_dir in "$@"; do
    # Strip optional hostname prefix
    if [[ "$benchmark_dir" == *@* ]]; then
        hostname="${benchmark_dir%%@*}"
        benchmark_dir="${benchmark_dir#*@}"
    else
        hostname="N/A"
    fi

    [[ -d "$benchmark_dir" ]] || continue

    # Find main log (script.log)
    latest_log=$(find_latest_log "$benchmark_dir" ".*" "^script")
    if [[ -z "$latest_log" || ! -f "$latest_log" ]]; then
        continue
    fi

    sys_sn=$(basename "$(dirname "$benchmark_dir")")
    extract_common_metadata "$latest_log"
    
    # Parse DCGM data similar to 99-parse_dcgm.sh
    bench_status="PASS"
    eud_present="No"
    
    while IFS= read -r line; do
        if [[ "$line" =~ \| ]]; then
            section=$(echo "$line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')
            result=$(echo "$line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); print $3}')
            
            if [[ "$section" == "eud" ]]; then
                eud_present="Yes"
            fi
            
            if [[ "$section" =~ ^(software|memory|diagnostic|nvbandwidth|pulse_test|eud|pcie|memtest|memory_bandwidth|targeted_stress|targeted_power)$ ]]; then
                if [[ "$result" != "Pass" ]]; then
                    bench_status="FAIL"
                fi
            fi
        fi
    done < <(awk '/\+---------------------------\+/{flag=1;next} /\+---------------------------\+/{flag=0} flag' "$latest_log")
    
    # Count GPU results
    gpu_fail_count=0
    gpu_total_count=0
    while IFS= read -r line; do
        if [[ "$line" =~ GPU[0-9]+: ]]; then
            gpu_total_count=$((gpu_total_count+1))
            if [[ "$line" != *"Pass"* ]]; then
                gpu_fail_count=$((gpu_fail_count+1))
            fi
        fi
    done < <(awk '/\+---------------------------\+/{flag=1;next} /\+---------------------------\+/{flag=0} flag' "$latest_log")
    
    # Parse DCGM exit code from summary
    dcgm_exit=$(grep "DCGM exit code:" "$latest_log" | tail -n1 | awk '{print $NF}')
    if [[ "$dcgm_exit" =~ ^[0-9]+$ ]] && [[ "$dcgm_exit" -ne 0 ]]; then
        bench_status="FAIL"
    fi
    
    # Calculate totals
    if [[ $gpu_total_count -gt 0 ]]; then
        tests_total=$gpu_total_count
    else
        tests_total=8
    fi
    tests_passed=$((tests_total - gpu_fail_count))
    tests_failed=$gpu_fail_count
    
    # Determine overall status
    status=$(check_exit_code "$latest_log" "$bench_status")
    
    # Console output (to stderr)
    cstatus=$([ "$status" == "PASS" ] && echo -e "${GREEN}PASS${RESET}" || echo -e "${RED}FAIL${RESET}")
    printf "[ %-*s | %-*s ]  %-*b | Tests: %d/%d Passed\n" \
        "$RACK_WIDTH" "$hostname" "$NODE_BENCH_WIDTH" "$sys_sn - DCGM" "$STATUS_WIDTH" "$cstatus" "$tests_passed" "$tests_total" >&2
    
    # CSV output (to stdout)
    echo "$latest_log,$sys_sn,$status,$time_start,$time_end,$duration,$tests_total,$tests_passed,$tests_failed,$eud_present"
done)

if [[ -n "$DCGM_ROWS" ]]; then
    echo ""
    echo "$DCGM_TITLE"
    echo "Log,SN,Result,Time Started,Time Completed,Duration,Total Tests, Tests Passed,Tests Failed,EUD"
    echo "$DCGM_ROWS"
fi

# ========== stress-ng Section ==========
# Process each node for stress-ng
STRESS_ROWS=$(for benchmark_dir in "$@"; do
    # Strip optional hostname prefix
    if [[ "$benchmark_dir" == *@* ]]; then
        hostname="${benchmark_dir%%@*}"
        benchmark_dir="${benchmark_dir#*@}"
    else
        hostname="N/A"
    fi

    [[ -d "$benchmark_dir" ]] || continue

    # Find main log (script.log)
    latest_log=$(find_latest_log "$benchmark_dir" ".*" "^script")
    if [[ -z "$latest_log" || ! -f "$latest_log" ]]; then
        continue
    fi

    sys_sn=$(basename "$(dirname "$benchmark_dir")")
    extract_common_metadata "$latest_log"
    
    # Parse passed/failed/skipped summary lines
    skipped=$(grep -i "skipped:" "$latest_log" | tail -n1 | sed -E 's/.*skipped:[[:space:]]*([0-9]+).*/\1/')
    passed=$(grep -i "passed:" "$latest_log" | tail -n1 | sed -E 's/.*passed:[[:space:]]*([0-9]+).*/\1/')
    failed=$(grep -i "failed:" "$latest_log" | tail -n1 | sed -E 's/.*failed:[[:space:]]*([0-9]+).*/\1/')

    skipped=${skipped:-0}
    passed=${passed:-0}
    failed=${failed:-0}
    
    # Determine benchmark-specific status
    [ "$failed" -eq 0 ] && bench_status="PASS" || bench_status="FAIL"
    
    # Parse stress-ng exit code from parallel summary block
    stress_exit=$(grep "stress-ng exit code:" "$latest_log" | tail -n1 | awk '{print $NF}')
    if [[ "$stress_exit" =~ ^[0-9]+$ ]] && [[ "$stress_exit" -ne 0 ]]; then
        bench_status="FAIL"
    fi
    
    # Overall status (authoritative Exit Code footer takes precedence)
    status=$(check_exit_code "$latest_log" "$bench_status")
    
    # Console output (to stderr)
    cstatus=$([ "$status" == "PASS" ] && echo -e "${GREEN}PASS${RESET}" || echo -e "${RED}FAIL${RESET}")
    total_tests=$((passed + failed + skipped))
    printf "[ %-*s | %-*s ]  %-*b | Tests: %s/%s Passed\n" \
        "$RACK_WIDTH" "$hostname" "$NODE_BENCH_WIDTH" "$sys_sn - Stress-ng" "$STATUS_WIDTH" "$cstatus" "$passed" "$total_tests" >&2
    
    # CSV output (to stdout)
    echo "$latest_log,$sys_sn,$status,$time_start,$time_end,$duration,$skipped,$passed,$failed"
done)

if [[ -n "$STRESS_ROWS" ]]; then
    echo ""
    echo "$STRESS_TITLE"
    echo "Log,SN,Result,Time started,Time Completed,Duration,Skipped,Passed,Failed"
    echo "$STRESS_ROWS"
fi
