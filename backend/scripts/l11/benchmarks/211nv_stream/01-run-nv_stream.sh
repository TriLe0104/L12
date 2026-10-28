#!/bin/bash

STREAM_DIR="${STREAM_DIR:-/opt/nvidia/nvidia_hpc_benchmarks_openmpi/cuda13/stream-gpu-linux-x86_64}"
STREAM_EXEC="$STREAM_DIR/stream_test"

echo "Running NVIDIA STREAM GPU memory bandwidth test..."

# Check if STREAM executable exists
if [[ ! -f "$STREAM_EXEC" ]]; then
    echo "ERROR: NVIDIA STREAM executable not found at $STREAM_EXEC"
    echo "Please ensure NVIDIA HPC Benchmarks are installed"
    exit 1
fi

# Change to STREAM directory
cd "$STREAM_DIR" || exit 1

# Detect number of GPUs
NUM_GPUS=$(nvidia-smi --list-gpus 2>/dev/null | wc -l)
if [[ $NUM_GPUS -eq 0 ]]; then
    echo "ERROR: No NVIDIA GPUs detected"
    exit 1
fi

echo "Detected $NUM_GPUS GPUs"

echo "Launching NVIDIA STREAM on all $NUM_GPUS GPUs..."
echo "=== NVIDIA STREAM Test Started ==="
echo "Number of GPUs: $NUM_GPUS"
echo ""

for g in $(seq 0 $((NUM_GPUS - 1))); do
    echo "=== GPU $g ==="
    "$STREAM_EXEC" -d "$g" 2>&1
    echo ""
done

echo "All GPU tests completed"
