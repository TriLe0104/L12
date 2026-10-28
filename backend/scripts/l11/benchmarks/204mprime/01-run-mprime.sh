#!/bin/bash

# --- Configurable variables ---
DURATION_MINUTES="${DURATION_MINUTES:-60}"
# ------------------------------

DURATION_SEC=$(( DURATION_MINUTES * 60 ))

# Local settings
PROJECT_ROOT="$(pwd)"
MPRIME_DIR="$PROJECT_ROOT/benchmarks/204mprime"
TARFILE="p95v3019b20.linux64.tar.gz"
TARURL="https://download.mersenne.ca/gimps/v30/30.19/$TARFILE"
MPRIME_EXEC="$MPRIME_DIR/mprime"

# Setup mprime locally (quiet)
setup_mprime() {
    mkdir -p "$MPRIME_DIR"
    cd "$MPRIME_DIR" || exit

    if [ ! -f "$TARFILE" ]; then
        echo "Downloading $TARFILE..."
        wget -q --no-check-certificate "$TARURL"
    fi
    if [ ! -f "$MPRIME_EXEC" ]; then
        echo "Extracting $TARFILE..."
        tar -xzf "$TARFILE" >/dev/null 2>&1
    fi

    echo "mprime setup completed in $MPRIME_DIR!"
}

# Run mprime locally (output visible) with timeout
run_mprime_local() {
    cd "$MPRIME_DIR" || exit
    echo "Running mprime locally for $DURATION_MINUTES minutes..."
    timeout "$DURATION_SEC"s "$MPRIME_EXEC" -t
    echo "Local mprime run completed after $DURATION_MINUTES minutes"
}

# Main
setup_mprime
run_mprime_local
