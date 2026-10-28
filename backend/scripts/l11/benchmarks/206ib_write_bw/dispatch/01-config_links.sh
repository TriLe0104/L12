# ===== config_links.sh =====
set -euo pipefail

usage() {
    echo "Usage: $0 --server | --client"
    exit 1
}

ROLE=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --server) ROLE="server" ;;
        --client) ROLE="client" ;;
        *) usage ;;
    esac
    shift
done

if [[ -z "$ROLE" ]]; then usage; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSV_FILE="$SCRIPT_DIR/rdma_map.csv"

# Read CSV and collect ifnames and assignments
declare -a IFNAME_LIST
declare -A IP_ASSIGNMENTS

{
    read -r header
    while IFS=, read -r dev ifname port client_ip server_ip gpu_id gpu_bus; do
        IFNAME_LIST+=("$ifname")
        if [[ "$ROLE" == "server" ]]; then
            IP_ASSIGNMENTS["$ifname"]="$server_ip"
        else
            IP_ASSIGNMENTS["$ifname"]="$client_ip"
        fi
    done
} < "$CSV_FILE"

# Flush old addresses, assign IPs, and bring links up
for ifname in "${IFNAME_LIST[@]}"; do
    ip addr flush dev "$ifname" || true
    IP_ADDR="${IP_ASSIGNMENTS[$ifname]}"
    ip addr add "${IP_ADDR}/30" dev "$ifname"
    ip link set "$ifname" up
    ip link set dev "$ifname" mtu 9000
done

sleep 2

# Check for interfaces still down
for ifname in "${IFNAME_LIST[@]}"; do
    if ip link show dev "$ifname" | grep -q DOWN; then
        echo "ERROR: Interface $ifname is still down" >&2
    fi
done

echo "$ROLE link IPs configured:"
ip -br addr | grep -E "$(printf '%s|' "${IFNAME_LIST[@]}" | sed 's/|$//')" | sort