#!/bin/bash
# IB write bandwidth benchmark parser
# Standalone parser script that outputs CSV section for this benchmark
# Usage: 99-parse_ib_write_bw.sh <benchmark_dir1> [benchmark_dir2 ...]

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

# Discover interfaces first (scan all logs to build dynamic HEADER)
declare -A all_interfaces
declare -a sorted_interfaces
for benchmark_dir in "$@"; do
    [[ "$benchmark_dir" == *@* ]] && benchmark_dir="${benchmark_dir#*@}"
    [[ -d "$benchmark_dir" ]] || continue
    LATEST_LOG=$(find_latest_log "$benchmark_dir" ".*" "^script")
    if [[ -n "$LATEST_LOG" && -f "$LATEST_LOG" ]]; then
        while read -r device; do
            if [[ -z "${all_interfaces[$device]:-}" ]]; then
                all_interfaces["$device"]=1
                sorted_interfaces+=("$device")
            fi
        done < <(awk '/Device[[:space:]]*:/ {print $NF}' "$LATEST_LOG")
    fi
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
    LATEST_LOG=$(find_latest_log "$benchmark_dir" ".*" "^script")
    if [[ -z "$LATEST_LOG" || ! -f "$LATEST_LOG" ]]; then
        continue
    fi

    sys_sn=$(basename "$(dirname "$benchmark_dir")")
    extract_common_metadata "$LATEST_LOG"
    
    # Parse device bandwidth data - RESET for each node
    unset device_avg_bw device_peak_bw device_measurements_avg device_measurements_peak
    declare -A device_avg_bw
    declare -A device_peak_bw
    
    # First pass: collect all measurements for each device
    declare -A device_measurements_avg
    declare -A device_measurements_peak
    
    while IFS=, read -r device peak_bw avg_bw; do
        # Store measurements, using semicolon as separator
        if [[ -n "${device_measurements_avg[$device]}" ]]; then
            device_measurements_avg["$device"]="${device_measurements_avg[$device]};$avg_bw"
            device_measurements_peak["$device"]="${device_measurements_peak[$device]};$peak_bw"
        else
            device_measurements_avg["$device"]="$avg_bw"
            device_measurements_peak["$device"]="$peak_bw"
        fi
    done < <(awk '
        BEGIN { OFS="," }
        /Device[[:space:]]*:/ {
            device = $NF
            next
        }
        /^[[:space:]]*65536[[:space:]]+[0-9]+[[:space:]]+[0-9.]+[[:space:]]+[0-9.]+/ {
            if (device != "" && NF >= 5) {
                print device, $3, $4
                device = ""
            }
        }
    ' "$LATEST_LOG")
    
    # Second pass: for each device, calculate average of averages and find highest value from all peaks and averages
    for device in "${!device_measurements_peak[@]}"; do
        IFS=';' read -ra peak_values <<< "${device_measurements_peak[$device]}"
        IFS=';' read -ra avg_values <<< "${device_measurements_avg[$device]}"
        
        # Use awk to find max and calculate average in one pass
        result=$(awk -v peaks="${device_measurements_peak[$device]}" -v avgs="${device_measurements_avg[$device]}" '
        BEGIN {
            split(peaks, peak_arr, ";")
            split(avgs, avg_arr, ";")
            
            max_val = 0
            sum = 0
            count = 0
            
            for (i in avg_arr) {
                if (avg_arr[i] + 0 > max_val) max_val = avg_arr[i] + 0
                if (peak_arr[i] + 0 > max_val) max_val = peak_arr[i] + 0
                sum += avg_arr[i]
                count++
            }
            
            avg = (count > 0) ? sum / count : 0
            printf "%.2f %.2f", max_val, avg
        }')
        
        read peak_bw avg_bw <<< "$result"
        
        device_peak_bw["$device"]="$peak_bw"
        device_avg_bw["$device"]="$avg_bw"
    done
    
    # Determine benchmark-specific status
    bench_status="PASS"
    if [ ${#device_avg_bw[@]} -eq 0 ]; then
        bench_status="FAIL"
    else
        # Check if any expected interface is missing (N/A)
        for device in "${sorted_interfaces[@]}"; do
            if [[ -z "${device_avg_bw[$device]:-}" || -z "${device_peak_bw[$device]:-}" ]]; then
                bench_status="FAIL"
                break
            fi
        done
        
        # Check bandwidth thresholds only if all devices present
        if [[ "$bench_status" == "PASS" ]]; then
            for device in "${!device_avg_bw[@]}"; do
                avg_bw="${device_avg_bw[$device]}"
                
                if [[ "$avg_bw" == "FAIL" ]]; then
                    bench_status="FAIL"
                    break
                fi
                
                # Determine theoretical maximum based on measured value
                if (( $(echo "$avg_bw < 100" | bc -l) )); then
                    theoretical_max=100
                elif (( $(echo "$avg_bw < 200" | bc -l) )); then
                    theoretical_max=200
                elif (( $(echo "$avg_bw < 400" | bc -l) )); then
                    theoretical_max=400
                else
                    theoretical_max=800
                fi
                
                # Require 95% of theoretical maximum
                if (( $(echo "$avg_bw < $theoretical_max*0.95" | bc -l) )); then
                    bench_status="FAIL"
                    break
                fi
            done
        fi
    fi
    
    # Check exit code (overrides benchmark status if non-zero)
    status=$(check_exit_code "$LATEST_LOG" "$bench_status")
    
    # Build CSV row with devices in discovered order
    row="$LATEST_LOG,$sys_sn,$status,$time_start,$time_end,$duration"
    
    for device in "${sorted_interfaces[@]}"; do
        row+=",${device_avg_bw[$device]:-N/A},${device_peak_bw[$device]:-N/A}"
    done
    
    # Console output (to stderr)
    if [ ${#device_avg_bw[@]} -eq 0 ]; then
        printf "[ %-*s | %-*s ] %-*s | No valid results found in log\n" \
            "$RACK_WIDTH" "$hostname" "$NODE_BENCH_WIDTH" "$sys_sn - ib_write_bw" "$STATUS_WIDTH" "${RED}FAIL${RESET}" >&2
    else
        if [ "$status" == "PASS" ]; then
            cstatus_text="PASS"
            cstatus_color="${GREEN}"
        else
            cstatus_text="FAIL"
            cstatus_color="${RED}"
        fi
        
        printf "[ %-*s | %-*s ] %s%-*s%s" \
            "$RACK_WIDTH" "$hostname" "$NODE_BENCH_WIDTH" "$sys_sn - ib_write_bw" \
            "$cstatus_color" "$STATUS_WIDTH" "$cstatus_text" "${RESET}" >&2
        
        # Use sorted_interfaces to maintain consistent order and show each device once
        maxlen=0
        for device in "${sorted_interfaces[@]}"; do
            if [[ -n "${device_avg_bw[$device]:-}" ]]; then
                (( ${#device} > maxlen )) && maxlen=${#device}
            fi
        done
        
        printf "\n" >&2
        for device in "${sorted_interfaces[@]}"; do
            # Skip if device not present in this node's results
            [[ -z "${device_avg_bw[$device]:-}" ]] && continue
            
            avg_bw=${device_avg_bw[$device]}
            peak_bw=${device_peak_bw[$device]}
            
            if [[ "$avg_bw" == "FAIL" ]]; then
                printf "    <=> %-*s : ${RED}Connectivity failed${RESET}\n" "$maxlen" "$device" >&2
            else
                # Determine theoretical maximum based on measured value
                if (( $(echo "$avg_bw < 100" | bc -l) )); then
                    theoretical_max=100
                elif (( $(echo "$avg_bw < 200" | bc -l) )); then
                    theoretical_max=200
                elif (( $(echo "$avg_bw < 400" | bc -l) )); then
                    theoretical_max=400
                else
                    theoretical_max=800
                fi
                
                avg_perc=$(awk -v bw="$avg_bw" -v expected="$theoretical_max" 'BEGIN {printf "%.2f", (bw/expected)*100}')
                printf "    [=] %-*s : Avg/Peak: %.2f/%.2f Gb/s  (%s%% of %s Gb/s)\n" "$maxlen" "$device" "$avg_bw" "$peak_bw" "$avg_perc" "$theoretical_max" >&2
            fi
        done
    fi
    
    # CSV output (to stdout)
    echo "$row"
    
    # Cleanup arrays for next iteration
    unset device_avg_bw device_peak_bw
done)

if [[ -n "$ROWS" ]]; then
    echo ""
    echo "${BENCHMARK_TITLE}"
    HEADER="Log,SN,Result,Time Started,Time Completed,Duration"
    for interface in "${sorted_interfaces[@]}"; do
        HEADER+=",${interface} Avg BW(GB/s),${interface} Peak BW(GB/s)"
    done
    echo "$HEADER"
    echo "$ROWS"
fi
