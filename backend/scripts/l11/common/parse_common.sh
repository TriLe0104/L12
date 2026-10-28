#!/bin/bash
# Common utilities for benchmark log parsing

source "$(dirname "${BASH_SOURCE[0]}")/colors.sh"

# Console output formatting widths
RACK_WIDTH=8
NODE_BENCH_WIDTH=32
STATUS_WIDTH=6

# Function to find latest log file matching a regex pattern
# Usage: find_latest_log <benchmark_dir> <pattern_regex> [exclude_pattern]
# Returns: path to the latest matching file, or empty string if none found
find_latest_log() {
    local benchmark_dir="$1"
    local pattern="${2:-.*}"  # Default to match all files
    local exclude_pattern="${3:-^$}"  # Default to exclude nothing
    
    find "$benchmark_dir" -maxdepth 1 -type f -printf '%T@ %p\n' 2>/dev/null | \
        sort -nr | \
        while read -r timestamp filepath; do
            filename=$(basename "$filepath")
            # Skip if filename matches exclude pattern
            if [[ "$filename" =~ $exclude_pattern ]]; then
                continue
            fi
            # Check if filename matches the include pattern
            if [[ "$filename" =~ $pattern ]]; then
                echo "$filepath"
                return 0
            fi
        done
}

# Function to extract common metadata from log file
# Usage: extract_common_metadata <log_file>
# Returns: Sets global variables time_start, time_end, duration
extract_common_metadata() {
    local log_file="$1"
    time_start=$(grep -m1 "TEST STARTED" "$log_file" | sed -E 's/.*: +//' | tr -d '\r\n')
    time_end=$(grep -m1 "TEST COMPLETED" "$log_file" | sed -E 's/.*: +//' | tr -d '\r\n')
    duration=$(grep -m1 "Duration" "$log_file" | cut -d: -f2- | xargs | cut -d' ' -f1 | tr -d '\r\n')
}

# Function to add row to CSV with placeholder replacement
# Usage: add_csv_row <csv_file> <placeholder> <row_data>
add_csv_row() {
    local csv_file="$1"
    local placeholder="$2"
    local row="$3"
    
    awk -v row="$row" -v ph="$placeholder" '{gsub(ph, row "\n" ph)}1' "$csv_file" > "$csv_file.tmp" && mv "$csv_file.tmp" "$csv_file"
}

# Function to get CSV header from parser
# Usage: get_csv_header <benchmark_type>
# Returns: CSV header string
get_csv_header() {
    local benchmark_type="$1"
    local func_name="get_${benchmark_type//-/_}_header"
    
    if type -t "$func_name" >/dev/null 2>&1; then
        "$func_name"
    else
        echo "Node,SN,Result,Time Started,Time Completed,Duration"
    fi
}

