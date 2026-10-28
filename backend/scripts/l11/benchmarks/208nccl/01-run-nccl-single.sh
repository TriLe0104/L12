#!/bin/bash

# --- Configurable variables ---
NCCL_MIN_BYTES="${NCCL_MIN_BYTES:-8}"
NCCL_MAX_BYTES="${NCCL_MAX_BYTES:-8G}"
NCCL_STEP_FACTOR="${NCCL_STEP_FACTOR:-2}"
# ------------------------------

echo "Running NCCL single-node tests..."

# Auto-detect GPU count
if command -v nvidia-smi &> /dev/null; then
    NGPUS=$(nvidia-smi --query-gpu=index --format=csv,noheader | wc -l)
    if [ -n "$CUDA_VISIBLE_DEVICES" ]; then
        IFS=',' read -ra VISIBLE_GPUS <<< "$CUDA_VISIBLE_DEVICES"
        VISIBLE_COUNT=${#VISIBLE_GPUS[@]}
        [ $VISIBLE_COUNT -lt $NGPUS ] && NGPUS=$VISIBLE_COUNT
    fi
    echo "Auto-detected $NGPUS GPUs"
else
    echo "ERROR: nvidia-smi not found. Cannot detect GPUs."
    exit 1
fi

# Function to find directories (respects existing environment variables)
find_all_paths() {
    local nccl_tests="$NCCL_TEST_DIR"
    local mpi_bin="$MPI_BIN_PATH"
    
    # Only search if not already defined in environment
    if [ -z "$nccl_tests" ]; then
        echo "Searching for nccl-tests/build..." >&2
        nccl_tests=$(find / -type d -name "build" -path "*/nccl-tests/build" 2>/dev/null | head -n 1)
    else
        echo "Using NCCL_TEST_DIR from environment: $nccl_tests" >&2
    fi
    
    # Validate NCCL test directory
    if [ -n "$nccl_tests" ] && [ -f "$nccl_tests/all_reduce_perf" ]; then
        echo "Found nccl-tests at: $nccl_tests" >&2
    else
        echo "ERROR: nccl-tests/build not found" >&2
        return 1
    fi
    
    if [ -z "$mpi_bin" ] && [ -z "${MPI_BIN_PATH}" ] && [ -z "${OMPI_BASE}" ]; then
        echo "Searching for OpenMPI..." >&2
        # Search in the nccl-tests parent tree
        local nccl_parent=$(dirname "$(dirname "$(dirname "$nccl_tests")")")
        
        # Detect required MPI library version from the binary
        local mpi_lib_needed=$(ldd "$nccl_tests/all_reduce_perf" 2>/dev/null | grep -o 'libmpi\.so[^ ]*' | head -n 1)
        
        local mpi_lib_local=""
        if [ -n "$mpi_lib_needed" ]; then
            echo "Binary requires: $mpi_lib_needed" >&2
            # Search with wildcard to match versioned files (e.g., libmpi.so.40.30.8)
            mpi_lib_local=$(find "$nccl_parent" -name "${mpi_lib_needed}*" -type f 2>/dev/null | head -n 1)
        fi
        
        # If specific version not found, search for any libmpi.so (excluding build artifacts)
        if [ -z "$mpi_lib_local" ]; then
            mpi_lib_local=$(find "$nccl_parent" -name "libmpi.so*" -type f 2>/dev/null | grep -v "\.libs" | head -n 1)
        fi
        
        if [ -n "$mpi_lib_local" ]; then
            echo "Found MPI library: $mpi_lib_local" >&2
            local mpi_lib_dir=$(dirname "$mpi_lib_local")
            local mpi_base=$(dirname "$mpi_lib_dir")
            if [ -f "$mpi_base/bin/mpirun" ]; then
                mpi_bin="$mpi_base/bin/mpirun"
            else
                mpi_bin="$mpi_lib_local"
            fi
        fi
    elif [ -n "${OMPI_BASE}" ]; then
        mpi_bin="${OMPI_BASE}/bin/mpirun"
    fi
    
    echo "$nccl_tests|$mpi_bin"
}

# Helper function to add to LD_LIBRARY_PATH
add_to_ld_path() {
    if [[ ":$LD_LIBRARY_PATH:" != *":$1:"* ]]; then
        if [ -z "$LD_LIBRARY_PATH" ]; then
            export LD_LIBRARY_PATH="$1"
        else
            export LD_LIBRARY_PATH="$1:$LD_LIBRARY_PATH"
        fi
        echo "Added $2 library: $1" >&2
    fi
}

# Helper function to add to PATH
add_to_path() {
    if [[ ":$PATH:" != *":$1:"* ]]; then
        export PATH="$PATH:$1"
        echo "Added $2 binary: $1" >&2
    fi
}

# Detect all paths and configure environment
FOUND_PATHS=$(find_all_paths)
IFS='|' read -r NCCL_TEST_DIR MPI_BIN_FOUND <<< "$FOUND_PATHS"
[ -z "$NCCL_TEST_DIR" ] && exit 1

# Add MPI library paths to environment
if [ -n "$MPI_BIN_FOUND" ]; then
    if [[ "$MPI_BIN_FOUND" == *.so* ]]; then
        # MPI library file path
        MPI_BASE=$(dirname "$(dirname "$MPI_BIN_FOUND")")
    else
        # MPI binary path
        MPI_BASE=$(dirname "$(dirname "$MPI_BIN_FOUND")")
    fi
    
    [ -d "$MPI_BASE/lib" ] && add_to_ld_path "$MPI_BASE/lib" "OpenMPI"
    [ -d "$MPI_BASE/bin" ] && add_to_path "$MPI_BASE/bin" "OpenMPI"
    export OPAL_PREFIX="$MPI_BASE"
    echo "Set OPAL_PREFIX: $MPI_BASE" >&2
fi

export OMPI_ALLOW_RUN_AS_ROOT=1
export OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1

# Function to run a test
run_nccl_test() {
    local test_name="$1"
    local test_binary="$2"

    echo "Running NCCL $test_name test..."
    "$test_binary" -b "$NCCL_MIN_BYTES" -e "$NCCL_MAX_BYTES" -f "$NCCL_STEP_FACTOR" -g "$NGPUS"
    local exit_code=$?
    
    if [ $exit_code -ne 0 ]; then
        echo "NCCL $test_name test failed with exit code $exit_code" >&2
    fi
}

# Run tests sequentially
run_nccl_test "all_reduce" "$NCCL_TEST_DIR/all_reduce_perf"
run_nccl_test "all_gather" "$NCCL_TEST_DIR/all_gather_perf"
# run_nccl_test "broadcast" "$NCCL_TEST_DIR/broadcast_perf"
# run_nccl_test "reduce" "$NCCL_TEST_DIR/reduce_perf"
# run_nccl_test "reduce_scatter" "$NCCL_TEST_DIR/reduce_scatter_perf"
run_nccl_test "alltoall" "$NCCL_TEST_DIR/alltoall_perf"

echo "All NCCL tests completed successfully."