#!/bin/bash

# --- Configurable variables ---
DURATION_MINUTES="${DURATION_MINUTES:-10}"
VM_MEM_PERCENT="${VM_MEM_PERCENT:-90}"
# ------------------------------

DURATION=$(( DURATION_MINUTES * 60 ))

echo "Running stress-ng CPU stress test for $DURATION_MINUTES minutes (vm-bytes: ${VM_MEM_PERCENT}%)..."

# Ensure stress-ng is installed silently
if ! command -v stress-ng &> /dev/null; then
    echo "stress-ng not found. Installing..."
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq stress-ng
fi

# Run stress-ng on all CPUs with matrix stressor
stress-ng --matrix 0 --vm 0 --vm-bytes "${VM_MEM_PERCENT}%" --timeout "${DURATION}s" --metrics-brief --tz
