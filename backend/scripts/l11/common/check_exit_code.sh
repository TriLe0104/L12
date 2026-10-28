#!/bin/bash

# Check exit code from log file
# Usage: check_exit_code <log_file> [default_status]
# Returns: "PASS" if exit code is 0, "FAIL" otherwise
# If default_status is provided and exit code is 0, returns default_status
# If default_status is not provided and exit code is 0, returns "PASS"

check_exit_code() {
    local log_file="$1"
    local default_status="${2:-PASS}"
    
    if [[ ! -f "$log_file" ]]; then
        echo "FAIL"
        return 1
    fi
    
    # Extract exit code from log footer
    local exit_code
    exit_code=$(grep -i "^Exit Code" "$log_file" | tail -n1 | sed -E 's/.*:[[:space:]]*([0-9]+).*/\1/')
    exit_code=${exit_code:-0}
    
    # If exit code is non-zero, return FAIL
    if [ "$exit_code" -ne 0 ]; then
        echo "FAIL"
        return 1
    fi
    
    # Exit code is 0, return the default status
    echo "$default_status"
    return 0
}
