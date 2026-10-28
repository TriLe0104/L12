#!/bin/bash
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$LIB_DIR/run_remote.sh"
get_sys_hostname() {
    local OS_IP="$1"
    if [[ -z "$OS_IP" ]]; then
        echo "Usage: get_sys_hostname <OS_IP>" >&2
        return 1
    fi
    run_remote "$OS_IP" "hostname" | tr -d '\n\r' | xargs
}
