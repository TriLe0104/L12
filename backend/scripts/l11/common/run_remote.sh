#!/bin/bash
REMOTE_USER="${REMOTE_USER:-root}"
PASS="${PASS:-test}"  # Use exported PASS if available, otherwise default to "test"
SSH_OPTS="-o StrictHostKeyChecking=no \
-o UserKnownHostsFile=/dev/null \
-o ConnectTimeout=10"

run_remote() {
    if [[ -z "$1" || -z "$2" ]]; then
        echo "Usage: run_remote <OS_IP> <COMMAND>" >&2
        return 1
    fi
    if ! command -v sshpass &>/dev/null; then
        echo "Error: 'sshpass' is required. Install with: sudo apt-get install sshpass" >&2
        return 2
    fi
    local OS_IP="$1"
    local CMD="$2"
    echo "$CMD" | sshpass -p "$PASS" ssh $SSH_OPTS "$REMOTE_USER@$OS_IP" bash 2> >(grep -v "Permanently added" >&2)
}