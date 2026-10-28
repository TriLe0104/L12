# ===== ping_test.sh =====
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSV_FILE="$SCRIPT_DIR/rdma_map.csv"

LOCAL_IPS="$(hostname -I)"
ROLE=""
declare -a ifnames client_ips server_ips

while IFS=, read -r dev IFNAME port client_ip server_ip _rest; do
    [[ -z "$ROLE" && " $LOCAL_IPS " == *" $server_ip "* ]] && ROLE="server"
    [[ -z "$ROLE" && " $LOCAL_IPS " == *" $client_ip "* ]] && ROLE="client"
    ifnames+=("$IFNAME")
    client_ips+=("$client_ip")
    server_ips+=("$server_ip")
done < <(tail -n +2 "$CSV_FILE")

if [[ -z "$ROLE" ]]; then
    echo "Error: could not determine role — no local IP matched server_ip or client_ip in $CSV_FILE" >&2
    echo "Please run 01-config_links.sh first to configure IP addresses." >&2
    exit 1
fi

echo "Running as: $ROLE" >&2

FAILED=0
declare -a pids
for i in "${!ifnames[@]}"; do
    if [[ "$ROLE" == "client" ]]; then
        SOURCE_IP="${client_ips[$i]}"; TARGET_IP="${server_ips[$i]}"
    else
        SOURCE_IP="${server_ips[$i]}"; TARGET_IP="${client_ips[$i]}"
    fi
    (
        if ping -c 2 "$TARGET_IP" -I "$SOURCE_IP" >/dev/null 2>&1; then
            echo "${ifnames[$i]}: SUCCESS $SOURCE_IP => $TARGET_IP" >&2
        else
            echo "${ifnames[$i]}: FAILED $SOURCE_IP => $TARGET_IP" >&2
            exit 1
        fi
    ) &
    pids+=($!)
done

for pid in "${pids[@]}"; do
    wait "$pid" || FAILED=1
done

[[ $FAILED -eq 1 ]] && exit 1

echo "All $ROLE pings successful"