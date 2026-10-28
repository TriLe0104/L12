#!/bin/bash
# This script should be dispatched to a node and run to execute NCCL multi-node tests.
echo "Running NCCL multi-node tests..."

# Check if at least two IP addresses are provided
if [ $# -lt 2 ]; then
    echo "ERROR: At least 2 IP addresses required for multi-node testing"
    echo "Usage: $0 <ip1> <ip2> [ip3] ..."
    exit 1
fi

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
if [ -z "$NCCL_TEST_DIR" ]; then
    echo "ERROR: Failed to locate NCCL test directory" >&2
    exit 1
fi

# Add MPI library paths to environment
if [ -n "$MPI_BIN_FOUND" ]; then
    if [[ "$MPI_BIN_FOUND" == *.so* ]]; then
        # MPI library file path - need to search for mpirun in the build tree
        MPI_LIB_DIR=$(dirname "$MPI_BIN_FOUND")
        # MPI_LIB_DIR is like: /root/testing/stevenp/ompi/build/ompi/.libs
        # Go up multiple levels to find the base directory
        MPI_BASE_CANDIDATE=$(dirname "$(dirname "$(dirname "$MPI_LIB_DIR")")")
        
        # Search for mpirun in common build directory patterns
        MPIRUN_PATH=""
        for build_subdir in "ompi-build/bin" "build/bin" "bin"; do
            SEARCH_PATH="$MPI_BASE_CANDIDATE/$build_subdir/mpirun"
            if [ -f "$SEARCH_PATH" ]; then
                MPIRUN_PATH="$SEARCH_PATH"
                echo "Found mpirun at: $MPIRUN_PATH" >&2
                MPIRUN_DIR=$(dirname "$MPIRUN_PATH")
                add_to_path "$MPIRUN_DIR" "mpirun"
                break
            fi
        done
        
        if [ -z "$MPIRUN_PATH" ]; then
            echo "WARNING: mpirun not found in standard locations, searching build tree..." >&2
            MPIRUN_PATH=$(find "$MPI_BASE_CANDIDATE" -name mpirun -type f 2>/dev/null | head -n 1)
            if [ -n "$MPIRUN_PATH" ]; then
                echo "Found mpirun at: $MPIRUN_PATH" >&2
                MPIRUN_DIR=$(dirname "$MPIRUN_PATH")
                add_to_path "$MPIRUN_DIR" "mpirun"
            else
                echo "ERROR: mpirun not found" >&2
            fi
        fi
        
        # Set MPI_BASE to directory containing lib and bin directories
        MPI_BASE="$MPI_BASE_CANDIDATE"
        # Add both standard lib and build lib directories
        [ -d "$MPI_BASE/lib" ] && add_to_ld_path "$MPI_BASE/lib" "OpenMPI"
        [ -d "$MPI_BASE/ompi-build/lib" ] && add_to_ld_path "$MPI_BASE/ompi-build/lib" "OpenMPI"
        [ -d "$MPI_BASE/build/lib" ] && add_to_ld_path "$MPI_BASE/build/lib" "OpenMPI"
    else
        # MPI binary path
        MPIRUN_PATH="$MPI_BIN_FOUND"
        MPI_BASE=$(dirname "$(dirname "$MPI_BIN_FOUND")")
        [ -d "$MPI_BASE/lib" ] && add_to_ld_path "$MPI_BASE/lib" "OpenMPI"
    fi
    
    [ -d "$MPI_BASE/bin" ] && add_to_path "$MPI_BASE/bin" "OpenMPI"
    [ -d "$MPI_BASE/ompi-build/bin" ] && add_to_path "$MPI_BASE/ompi-build/bin" "OpenMPI"
    export OPAL_PREFIX="$MPI_BASE"
    echo "Set OPAL_PREFIX: $MPI_BASE" >&2
fi

export OMPI_ALLOW_RUN_AS_ROOT=1
export OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1
echo ""

# Create temporary hostfile
HOSTFILE=$(mktemp /tmp/nccl_hostfile.XXXXXX)
trap "rm -f $HOSTFILE" EXIT INT TERM

# Write IPs to hostfile (one per line)
for ip in "$@"; do
    echo "$ip" >> "$HOSTFILE"
    
done

NUM_NODES=$#
echo "Created hostfile with $NUM_NODES nodes:"
cat "$HOSTFILE"

# Calculate total number of processes (GPUs per node * number of nodes)
TOTAL_PROCS=$((NUM_NODES * NGPUS))
echo "Total processes: $TOTAL_PROCS (${NUM_NODES} nodes x ${NGPUS} GPUs)"
echo ""

# Use full path to mpirun if found, otherwise rely on PATH
MPIRUN_CMD="${MPIRUN_PATH:-mpirun}"

# Load active mlx5 devices written by 01-setup-interfaces.sh
DEVICES_FILE="/tmp/nccl_active_devices"
if [ -f "$DEVICES_FILE" ]; then
    mapfile -t _active_devs < "$DEVICES_FILE"
    NCCL_IB_HCA=$(IFS=','; echo "${_active_devs[*]}")
    UCX_NET_DEVICES=$(printf '%s:1,' "${_active_devs[@]}" | sed 's/,$//')
    echo "Using IB devices from $DEVICES_FILE: $NCCL_IB_HCA"
else
    echo "WARNING: $DEVICES_FILE not found, using hardcoded device list" >&2
    NCCL_IB_HCA="mlx5_0,mlx5_1,mlx5_4,mlx5_5,mlx5_6,mlx5_10,mlx5_11,mlx5_12"
    UCX_NET_DEVICES="mlx5_0:1,mlx5_1:1,mlx5_4:1,mlx5_5:1,mlx5_6:1,mlx5_10:1,mlx5_11:1,mlx5_12:1"
fi

# MPI command base with all configuration options
# TODO check how to set NCCL_SOCKET_IFNAME dynamically
MPI_BASE="mpirun -np $TOTAL_PROCS \
--allow-run-as-root \
--hostfile $HOSTFILE \
--bind-to none \
--map-by ppr:${NGPUS}:node \
--mca pml ucx \
--mca btl ^openib,self,vader \
-x LD_LIBRARY_PATH=$LD_LIBRARY_PATH \
-x PATH=$PATH \
-x NCCL_SOCKET_IFNAME=ens3923f0np0 \
-x NCCL_IB_HCA=$NCCL_IB_HCA \
-x UCX_NET_DEVICES=$UCX_NET_DEVICES \
-x UCX_TLS=dc_x,rc_x,ud_x,sm,self \
-x NCCL_IB_CUDA_SUPPORT=1 \
-x NCCL_NET_GDR_LEVEL=SYS"

# Use NVLSTree algorithm only for 2-node runs
[ "$NUM_NODES" -eq 2 ] && MPI_BASE="$MPI_BASE -x NCCL_ALGO=NVLSTree"

# Cleanup: Kill any existing NCCL test processes on all nodes
echo "Cleaning up existing NCCL processes on all nodes..."
for ip in "$@"; do
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@"$ip" \
    "pkill -9 'all_reduce_perf|all_gather_perf|broadcast_perf|reduce_perf|reduce_scatter_perf|alltoall_perf' 2>/dev/null || true" &
done
wait
echo "Process cleanup complete"
echo ""

# NCCL test commands (1 GPU per MPI rank)
NCCL_ALL_REDUCE_CMD="$MPI_BASE $NCCL_TEST_DIR/all_reduce_perf -b 8 -e 16G -f 2 -g 1"
NCCL_ALL_GATHER_CMD="$MPI_BASE $NCCL_TEST_DIR/all_gather_perf -b 8 -e 16G -f 2 -g 1"
NCCL_ALL_TO_ALL_CMD="$MPI_BASE $NCCL_TEST_DIR/alltoall_perf -b 8 -e 16G -f 2 -g 1"

# Function to run a test and check exit code
run_test() {
    local test_name="$1"
    local test_cmd="$2"
    
    echo "Running NCCL $test_name test..."
    $test_cmd
    local exit_code=$?
    
    if [ $exit_code -ne 0 ]; then
        echo "NCCL $test_name test failed with exit code $exit_code" >&2
        exit $exit_code
    fi
}

# Run the tests sequentially
run_test "all_reduce" "$NCCL_ALL_REDUCE_CMD"
[ "$NUM_NODES" -ge 3 ] && run_test "all_gather" "$NCCL_ALL_GATHER_CMD"
run_test "alltoall" "$NCCL_ALL_TO_ALL_CMD"
echo "All NCCL tests completed successfully."
exit 0
