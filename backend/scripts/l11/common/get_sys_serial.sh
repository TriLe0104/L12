#!/bin/bash
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$LIB_DIR/run_remote.sh"
get_sys_serial() {
    local OS_IP="$1"
    if [[ -z "$OS_IP" ]]; then
        echo "Usage: get_sys_serial <OS_IP>" >&2
        return 1
    fi

    local raw_sn rc ssh_err_file ssh_err
    ssh_err_file=$(mktemp)

    raw_sn=$(run_remote "$OS_IP" "dmidecode -s system-serial-number" 2>"$ssh_err_file")
    rc=$?

    if [[ $rc -ne 0 ]]; then
        ssh_err=$(<"$ssh_err_file")
        rm -f "$ssh_err_file"

        # Detect a stale known_hosts entry caused by a changed server SSH host key.
        # run_remote already uses StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null,
        # but the system-wide /etc/ssh/ssh_known_hosts may still carry the old fingerprint.
        # Self-heal: remove the stale entry and retry once.
        if echo "$ssh_err" | grep -qiE "REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed"; then
            echo "Warning: SSH host key for $OS_IP has changed – removing stale known_hosts entry and retrying..." >&2
            ssh-keygen -R "$OS_IP" -f ~/.ssh/known_hosts >/dev/null 2>&1 || true
            raw_sn=$(run_remote "$OS_IP" "dmidecode -s system-serial-number" 2>/dev/null)
            rc=$?
        fi

        if [[ $rc -ne 0 ]]; then
            if [[ -n "$ssh_err" ]]; then
                echo "Error: Failed to connect to $OS_IP – ${ssh_err}" >&2
            else
                echo "Error: Failed to run dmidecode on $OS_IP." >&2
            fi
            return 1
        fi
    else
        rm -f "$ssh_err_file"
    fi

    local sn
    sn=$(echo "$raw_sn" | head -n1 | tr -d '[:space:]')
    if [[ -z "$sn" ]]; then
        echo "Warning: dmidecode returned an empty serial number from $OS_IP. Treating SN as UNKNOWN." >&2
        echo "UNKNOWN"
        return 0
    fi
    echo "$sn"
}

# Allow direct invocation
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    get_sys_serial "$@"
fi