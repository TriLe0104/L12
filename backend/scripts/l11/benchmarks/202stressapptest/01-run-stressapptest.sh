#!/bin/bash

# --- Configurable variables ---
DURATION_MINUTES="${DURATION_MINUTES:-10}"
MEM_PERCENT="${MEM_PERCENT:-80}"
# ------------------------------

DURATION=$(( DURATION_MINUTES * 60 ))

echo "Running stressapptest for $DURATION_MINUTES minutes..."

# Ensure stressapptest is installed silently
if ! command -v stressapptest &> /dev/null; then
    echo "stressapptest not found. Installing..."
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq stressapptest
fi

# Calculate system memory (MB) and CPUs
TOTAL_MEM=$(free -m | awk '/Mem:/ {print $2}')
USE_MEM=$(( TOTAL_MEM * MEM_PERCENT / 100 ))
CPU_COUNT=$(nproc)

echo "Using $USE_MEM MB memory and $CPU_COUNT threads"

# Run stressapptest
stressapptest -s "$DURATION" -M "$USE_MEM" -m "$CPU_COUNT" -W --cc_test
