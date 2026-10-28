#!/bin/bash

# --- Configurable variables ---
DCGM_DIAG_LEVEL="${DCGM_DIAG_LEVEL:-4}"
# ------------------------------

# Runs dcgm benchmark, will take 2-3 hours. No console output when running.
if ! command -v dcgmi &> /dev/null; then
    # EUD cannot be install automatically, refer to SOP
    echo "dcgmi not found. Installing..."
    CUDA_VER=$(nvidia-smi | grep "CUDA Version" | sed -E 's/.*CUDA Version: ([0-9]+).*/\1/')
    PKG="datacenter-gpu-manager-4-cuda${CUDA_VER}"

    echo "Detected CUDA version: ${CUDA_VER}"
    echo "Installing: ${PKG}"
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$PKG"
    systemctl enable nvidia-dcgm
    systemctl restart dcgm
fi

dcgmi diag -r "$DCGM_DIAG_LEVEL"
