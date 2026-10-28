# ===== run_bw.sh =====
set -euo pipefail

usage() {
    echo "Automatically detects role (client/server) based on local IPs and rdma_map.csv, then runs ib_write_bw accordingly."
    echo "Usage: $0 [--reverse] [-n NUM_ITERS] [-D DURATION] [-I LOOPS]"
    echo "  --reverse:    Reverse client/server roles"
    echo "  -n NUM_ITERS: Number of iterations per queue pair (default: 20000)"
    echo "  -D DURATION:  Test duration in seconds (overrides -n)"
    echo "  -I LOOPS:     Number of times to repeat the benchmark (default: 1)"
    exit 1
}

REVERSE=false
NUM_ITERS=20000
DURATION=""
LOOPS=1

while [[ $# -gt 0 ]]; do
    case $1 in
        --reverse) REVERSE=true ;;
        -n) NUM_ITERS="$2"; shift ;;
        -D) DURATION="$2"; shift ;;
        -I) LOOPS="$2"; shift ;;
        *) usage ;;
    esac
    shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSV_FILE="$SCRIPT_DIR/rdma_map.csv"
LOG_DIR="$(mktemp -d)"
MONITOR_CSV="/tmp/ib_write_bw_nic_monitor_$(date -u +%Y%m%dT%H%M%SZ).csv"
SLEEP_INTERVAL=60

# Auto-detect role by matching local IPs against rdma_map.csv
LOCAL_IPS="$(hostname -I)"
ROLE=""
while IFS=, read -r dev ifname port client_ip server_ip _rest; do
    if [[ " $LOCAL_IPS " == *" $server_ip "* ]]; then
        ROLE="server"; break
    elif [[ " $LOCAL_IPS " == *" $client_ip "* ]]; then
        ROLE="client"; break
    fi
done < <(tail -n +2 "$CSV_FILE")

if [[ -z "$ROLE" ]]; then
    echo "Error: could not determine role — no local IP matched server_ip or client_ip in $CSV_FILE" >&2
    echo "Please run 01-config_links.sh first to configure IP addresses." >&2
    exit 1
fi
$REVERSE && { [[ "$ROLE" == "server" ]] && ROLE="client" || ROLE="server"; }
echo "Running as: $ROLE" >&2

find_gid_index() {
    local dev="$1" ip="$2"
    ibv_devinfo -v -d "$dev" -i 1 | \
        awk -v ip="$ip" '/GID\[/ { idx = $2; sub(/]:/, "", idx) } /::ffff:/ && $0 ~ ip { print idx; exit }'
}

numa_prefix() {
    local node
    node="$(cat "/sys/class/infiniband/${1}/device/numa_node" 2>/dev/null || echo -1)"
    [[ "$node" -ge 0 ]] && command -v numactl >/dev/null 2>&1 && echo "numactl --cpunodebind=$node --membind=$node" || echo ""
}

print_available_results() {
    for i in "${!LOG_FILES[@]}"; do
        [[ -f "${LOG_FILES[$i]}" ]] || continue
        echo "----- ${LOG_LABELS[$i]} -----"
        cat "${LOG_FILES[$i]}"
    done
}

# --- Build monitoring headers from CSV ifnames ---
declare -A IFACE_MAP   # dev -> ifname
declare -a DEVICES=()
HEADER="Timestamp"

while IFS=, read -r dev ifname port client_ip server_ip _rest; do
    DEVICES+=("$dev")
    IFACE_MAP["$dev"]="$ifname"
    HEADER+=",${ifname}_dev_temp,${ifname}_mod_temp,${ifname}_V"
    for i in {1..8}; do HEADER+=",${ifname}_TxBias_Ch${i}_mA"; done
    for i in {1..8}; do HEADER+=",${ifname}_TxPwr_Ch${i}_mW"; done
    for i in {1..8}; do HEADER+=",${ifname}_RxPwr_Ch${i}_mW"; done
done < <(tail -n +2 "$CSV_FILE")

echo "$HEADER" > "$MONITOR_CSV"
echo "Monitoring output: $MONITOR_CSV" >&2

# --- Monitoring loop (runs in background, exits when sentinel is removed) ---
monitor_loop() {
    set +e  # sensor reads are best-effort; a failed command must not kill the loop
    local sentinel="$1"
    while [[ -f "$sentinel" ]]; do
        ROW_DATA=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

        for DEV_ID in "${DEVICES[@]}"; do
            IFACE="${IFACE_MAP[$DEV_ID]}"

            ETH_OUT=$(ethtool -m "$IFACE" 2>/dev/null)

            M_TEMP=$(echo "$ETH_OUT" | awk -F': ' '/Module temperature/        {print $2}' | awk '{print $1}' | head -n 1)
            VOLT=$(echo "$ETH_OUT"   | awk -F': ' '/Module voltage/            {print $2}' | awk '{print $1}' | head -n 1)

            ROW_DATA+=",N/A,${M_TEMP:-N/A},${VOLT:-N/A}"

            TX_BIAS=$(echo "$ETH_OUT" | grep "Laser tx bias current (Channel [1-8])"          | awk -F': ' '{print $2}' | awk '{print $1}' | paste -sd "," -)
            TX_OPT=$(echo "$ETH_OUT"  | grep "Transmit avg optical power (Channel [1-8])"     | awk -F': ' '{print $2}' | awk '{print $1}' | paste -sd "," -)
            RX_OPT=$(echo "$ETH_OUT"  | grep "Rcvr signal avg optical power (Channel [1-8])"  | awk -F': ' '{print $2}' | awk '{print $1}' | paste -sd "," -)

            ROW_DATA+=",${TX_BIAS:-N/A,N/A,N/A,N/A,N/A,N/A,N/A,N/A}"
            ROW_DATA+=",${TX_OPT:-N/A,N/A,N/A,N/A,N/A,N/A,N/A,N/A}"
            ROW_DATA+=",${RX_OPT:-N/A,N/A,N/A,N/A,N/A,N/A,N/A,N/A}"
        done

        echo "$ROW_DATA" >> "$MONITOR_CSV"
        sleep "$SLEEP_INTERVAL"
    done
}

SENTINEL="$LOG_DIR/running"
touch "$SENTINEL"
monitor_loop "$SENTINEL" &
MONITOR_PID=$!

declare -a BW_PIDS=() LOG_FILES=() LOG_LABELS=()
cleanup() {
    echo "" >&2
    echo "Interrupted — stopping benchmark processes..." >&2
    [[ ${#BW_PIDS[@]} -gt 0 ]] && { kill "${BW_PIDS[@]}" 2>/dev/null || true; wait "${BW_PIDS[@]}" 2>/dev/null || true; }
    print_available_results
    rm -f "$SENTINEL"
    wait "$MONITOR_PID" 2>/dev/null || true
    rm -rf "$LOG_DIR"
    exit 130
}
trap cleanup INT TERM

# --- Build iteration/duration arg ---
if [[ -n "$DURATION" ]]; then
    ITER_ARG="-D $DURATION"
else
    ITER_ARG="-n $NUM_ITERS"
fi

# --- Run benchmark LOOPS times ---
for (( LOOP=1; LOOP<=LOOPS; LOOP++ )); do
    [[ "$LOOPS" -gt 1 ]] && echo "RUN $LOOP [$(date -u +"%Y-%m-%dT%H:%M:%SZ")]" >&2

    pkill ib_write_bw || true
    [[ "$ROLE" == "client" ]] && sleep 1 || true

    declare -a LOG_FILES=()
    declare -a LOG_LABELS=()
    declare -a BW_PIDS=()
    THREAD_IDX=0

    { read -r _header; while IFS=, read -r dev ifname port client_ip server_ip gpu_id gpu_bus; do
        if [[ "$ROLE" == "server" ]]; then
            BIND_IP="$($REVERSE && echo "$client_ip" || echo "$server_ip")"
            SERVER_ARG=""
        else
            BIND_IP="$($REVERSE && echo "$server_ip" || echo "$client_ip")"
            SERVER_ARG="$($REVERSE && echo "$client_ip" || echo "$server_ip")"
        fi

        GID_INDEX="$(find_gid_index "$dev" "$BIND_IP")"
        [[ -z "$GID_INDEX" ]] && GID_INDEX=3

        GPU_PARAMS=""
        if [[ "$gpu_id" != "N/A" ]]; then
            if command -v nvidia-smi >/dev/null 2>&1; then
                GPU_PARAMS="--use_cuda $gpu_id --use_cuda_bus_id $gpu_bus --use_cuda_dmabuf"
            elif command -v rocm-smi >/dev/null 2>&1; then
                # Waiting for dmabuf to be fixed by AMD
                # GPU_PARAMS="--use_rocm=$gpu_id --use_rocm_dmabuf"
                :
            fi
        fi

        CMD="$(numa_prefix "$dev") ib_write_bw -d $dev -p $port --report_gbits -F -q 8 --gid-index $GID_INDEX $ITER_ARG $GPU_PARAMS $SERVER_ARG --bind_source_ip $BIND_IP"

        if [[ "$gpu_id" == "N/A" ]]; then
            LABEL="$ROLE (no GPU): $dev port $port $BIND_IP GID $GID_INDEX"
        else
            LABEL="$ROLE: $dev port $port $BIND_IP GPU $gpu_id bus $gpu_bus GID $GID_INDEX"
        fi

        LOG_FILE="$LOG_DIR/loop${LOOP}_thread_${THREAD_IDX}.log"
        LOG_FILES+=("$LOG_FILE")
        LOG_LABELS+=("$LABEL")

        echo "Starting: $LABEL" >&2
        echo "Command: $CMD" >&2
        (
            rc=0
            eval "$CMD" > "$LOG_FILE" 2>&1 || rc=$?
            if [[ $rc -ne 0 ]]; then
                echo "FAILED (exit $rc): $LABEL" >&2
                cat "$LOG_FILE" >&2
            else
                echo "Finished: $LABEL" >&2
            fi
        ) &
        BW_PIDS+=($!)

        THREAD_IDX=$(( THREAD_IDX + 1 ))
    done } < "$CSV_FILE"

    LOOP_FAILED=0
    for pid in "${BW_PIDS[@]}"; do
        wait "$pid" || LOOP_FAILED=1
    done
    print_available_results
    [[ $LOOP_FAILED -eq 0 ]] || { echo "ERROR: one or more ib_write_bw processes failed in loop $LOOP — see output above" >&2; exit 1; }
done

# Signal monitor to stop and wait for it to flush its last row
rm -f "$SENTINEL"
wait $MONITOR_PID || true

echo "Monitoring complete. Data saved to: $MONITOR_CSV" >&2

rm -rf "$LOG_DIR"
