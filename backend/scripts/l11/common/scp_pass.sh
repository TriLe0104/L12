#!/bin/bash
REMOTE_USER="${REMOTE_USER:-root}"
PASS="${PASS:-test}"  # Use exported PASS if available, otherwise default to "test"
SSH_OPTS="-o StrictHostKeyChecking=no \
-o UserKnownHostsFile=/dev/null \
-o ConnectTimeout=10"

scp_pass() {
    if [[ $# -lt 4 ]]; then
        echo "Usage: scp_pass <local_file_dir> <remote_file_dir> <remote_ip> <to-remote|to-local> [scp_options...]" >&2
        echo "  local_file_dir: local file or directory path" >&2
        echo "  remote_file_dir: remote file or directory path" >&2
        echo "  remote_ip: IP address of remote host" >&2
        echo "  direction: 'to-remote' or 'to-local'" >&2
        echo "  scp_options: optional flags like -r for recursive" >&2
        return 1
    fi
    if ! command -v sshpass &>/dev/null; then
        echo "Error: 'sshpass' is required. Install with: sudo apt-get install sshpass" >&2
        return 2
    fi

    local local_path="$1"
    local remote_path="$2"
    local remote_ip="$3"
    local direction="$4"
    shift 4

    case "$direction" in
        to-remote)
            sshpass -p "$PASS" scp $SSH_OPTS "$@" "$local_path" "$REMOTE_USER@$remote_ip:$remote_path" 2> >(grep -v "Permanently added" >&2)
            ;;
        to-local)
            sshpass -p "$PASS" scp $SSH_OPTS "$@" "$REMOTE_USER@$remote_ip:$remote_path" "$local_path" 2> >(grep -v "Permanently added" >&2)
            ;;
        *)
            echo "Error: direction must be 'to-remote' or 'to-local'" >&2
            return 1
            ;;
    esac
}
