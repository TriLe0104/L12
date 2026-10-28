#!/bin/bash

# --- Configurable variables ---
DURATION_MINUTES="${DURATION_MINUTES:-2880}"
DCGM_DIAG_LEVEL="${DCGM_DIAG_LEVEL:-4}"
VM_MEM_PERCENT="${VM_MEM_PERCENT:-90}"
# ------------------------------

# Run DCGM and stress-ng in parallel, collect outputs, and print at the end

# Optional argument: stress-ng runtime in minutes (default 10)
STRESS_DURATION_MINUTES="${1:-4320}"

# Calculate DCGM loops (DCGM r4 takes ~144 minutes)
DCGM_DURATION=144
DCGM_LOOPS=$(( (DURATION_MINUTES + DCGM_DURATION - 1) / DCGM_DURATION ))

# Create temporary files for output capture
DCGM_OUTPUT=$(mktemp)
STRESS_OUTPUT=$(mktemp)

# Cleanup function to remove temp files on exit
cleanup() {
    rm -f "$DCGM_OUTPUT" "$STRESS_OUTPUT"
}
trap cleanup EXIT

# Run DCGM in background, capture output
(
    if ! command -v dcgmi &> /dev/null; then
        CUDA_VER=$(nvidia-smi | grep "CUDA Version" | sed -E 's/.*CUDA Version: ([0-9]+).*/\1/')
        PKG="datacenter-gpu-manager-4-cuda${CUDA_VER}"
        sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >> "$DCGM_OUTPUT" 2>&1
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$PKG" >> "$DCGM_OUTPUT" 2>&1
        systemctl enable nvidia-dcgm >> "$DCGM_OUTPUT" 2>&1
        systemctl restart dcgm >> "$DCGM_OUTPUT" 2>&1
    fi

    for i in $(seq 1 $DCGM_LOOPS); do
        > "$DCGM_OUTPUT"
        echo "======== DCGM Run $i/$DCGM_LOOPS ========" >> "$DCGM_OUTPUT" 2>&1
        dcgmi diag -r "$DCGM_DIAG_LEVEL" >> "$DCGM_OUTPUT" 2>&1
        DCGM_EXIT=$?
        echo "Exit code: $DCGM_EXIT" >> "$DCGM_OUTPUT" 2>&1
        if [ $DCGM_EXIT -ne 0 ]; then
            break
        fi
    done
) &
DCGM_PID=$!

# Run stress-ng in background, capture output
(
    STRESS_DURATION=$(( DURATION_MINUTES * 60 ))

    if ! command -v stress-ng &> /dev/null; then
        sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >> "$STRESS_OUTPUT" 2>&1
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq stress-ng >> "$STRESS_OUTPUT" 2>&1
    fi
    stress-ng --matrix 0 --vm 0 --vm-bytes "${VM_MEM_PERCENT}%" --timeout "${STRESS_DURATION}s" --metrics-brief --tz >> "$STRESS_OUTPUT" 2>&1
    echo "Exit code: $?" >> "$STRESS_OUTPUT" 2>&1
) &
STRESS_PID=$!

# Wait for both processes to complete
wait $STRESS_PID
STRESS_EXIT=$?

wait $DCGM_PID
DCGM_EXIT=$?

# Print outputs
echo "==================== DCGM OUTPUT ===================="
cat "$DCGM_OUTPUT"
echo ""
echo "==================== stress-ng OUTPUT ===================="
cat "$STRESS_OUTPUT"
echo ""

# Print summary
echo "==================== SUMMARY ===================="
echo "DCGM exit code: $DCGM_EXIT"
echo "stress-ng exit code: $STRESS_EXIT"

if [ $DCGM_EXIT -eq 0 ] && [ $STRESS_EXIT -eq 0 ]; then
    exit 0
else
    exit 1
fi
