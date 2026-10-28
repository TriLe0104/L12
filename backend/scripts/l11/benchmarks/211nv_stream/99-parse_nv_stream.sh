#!/bin/bash
# NVIDIA STREAM benchmark parser
# Standalone parser script that outputs CSV section for this benchmark
# Usage: 99-parse_nv_stream.sh <benchmark_dir1> [benchmark_dir2 ...]

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

# Detect number of GPUs from the first available script log
NUM_GPUS=8  # Default fallback
for benchmark_dir in "$@"; do
    [[ "$benchmark_dir" == *@* ]] && benchmark_dir="${benchmark_dir#*@}"
    [[ -d "$benchmark_dir" ]] || continue
    FIRST_LOG=$(find "$benchmark_dir" -maxdepth 1 -name "*.log" | sort | tail -n1)
    if [[ -f "$FIRST_LOG" ]]; then
        DETECTED_GPUS=$(grep "^Number of GPUs:" "$FIRST_LOG" | head -n1 | awk '{print $NF}')
        if [[ -n "$DETECTED_GPUS" && "$DETECTED_GPUS" =~ ^[0-9]+$ ]]; then
            NUM_GPUS=$DETECTED_GPUS
            break
        fi
    fi
done

# Build dynamic CSV header
HEADER="Log,SN,Result,Time started,Time Completed,Duration"
for g in $(seq 0 $((NUM_GPUS - 1))); do
    HEADER="${HEADER},GPU${g}_Copy,GPU${g}_Scale,GPU${g}_Add,GPU${g}_Triad"
done

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
    latest_log=$(find "$benchmark_dir" -maxdepth 1 -name "*.log" | sort | tail -n1)
    if [[ -z "$latest_log" || ! -f "$latest_log" ]]; then
        continue
    fi

    sys_sn=$(basename "$(dirname "$benchmark_dir")")
    extract_common_metadata "$latest_log"
    
    # Check for overall exit code
    exit_status=$(check_exit_code "$latest_log" "PASS")
    
    # Parse all GPU results directly from script log using === GPU N === section boundaries
    declare -A gpu_data
    all_passed=true
    gpu_count=0

    for g in $(seq 0 $((NUM_GPUS - 1))); do
        gpu_section=$(awk "BEGIN{p=0} /^=== GPU $g ===[[:space:]]*$/{p=1; next} /^=== GPU /{p=0} p{print}" "$latest_log")

        copy_rate=$(echo "$gpu_section" | grep "^Copy:" | awk '{printf "%d", $2}')
        scale_rate=$(echo "$gpu_section" | grep "^Scale:" | awk '{printf "%d", $2}')
        add_rate=$(echo "$gpu_section" | grep "^Add:" | awk '{printf "%d", $2}')
        triad_rate=$(echo "$gpu_section" | grep "^Triad:" | awk '{printf "%d", $2}')

        if [[ -z "$copy_rate" || -z "$scale_rate" || -z "$add_rate" || -z "$triad_rate" ]]; then
            all_passed=false
            gpu_data["${g}_copy"]="N/A"
            gpu_data["${g}_scale"]="N/A"
            gpu_data["${g}_add"]="N/A"
            gpu_data["${g}_triad"]="N/A"
        else
            gpu_data["${g}_copy"]="$copy_rate"
            gpu_data["${g}_scale"]="$scale_rate"
            gpu_data["${g}_add"]="$add_rate"
            gpu_data["${g}_triad"]="$triad_rate"
            ((gpu_count++))
        fi
    done
    
    # Determine overall status
    if [[ "$exit_status" != "PASS" ]] || [[ "$all_passed" != true ]]; then
        status="FAIL"
    else
        status="PASS"
    fi
    
    # Console output (to stderr)
    cstatus=$([ "$status" == "PASS" ] && echo -e "${GREEN}PASS${RESET}" || echo -e "${RED}FAIL${RESET}")
    
    printf "[ %-*s | %-*s ]  %-*b | %d/%d GPUs\n" \
        "$RACK_WIDTH" "$hostname" "$NODE_BENCH_WIDTH" "$sys_sn - NV STREAM" "$STATUS_WIDTH" "$cstatus" "$gpu_count" "$NUM_GPUS" >&2
    
    # CSV output (to stdout) - one row per node with all GPU data
    csv_row="$latest_log,$sys_sn,$status,$time_start,$time_end,$duration"
    for g in $(seq 0 $((NUM_GPUS - 1))); do
        csv_row="${csv_row},${gpu_data[${g}_copy]},${gpu_data[${g}_scale]},${gpu_data[${g}_add]},${gpu_data[${g}_triad]}"
    done
    echo "$csv_row"
    
done)

if [[ -n "$ROWS" ]]; then
    echo ""
    echo "${BENCHMARK_TITLE}"
    echo "$HEADER"
    echo "$ROWS"
fi
