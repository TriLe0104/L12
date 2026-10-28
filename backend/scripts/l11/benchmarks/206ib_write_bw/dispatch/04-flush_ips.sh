#!/bin/bash
# flush_ips.sh
# Flush IP addresses based on rdma_map.csv in script dir

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSV="$SCRIPT_DIR/rdma_map.csv"

while IFS=, read -r dev ifname port client server cuda bus; do
    [ "$ifname" = "ifname" ] && continue
    ip addr flush dev "$ifname" || true
done < "$CSV"
