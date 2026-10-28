#!/usr/bin/env bash
# 03-sel_find_active_errors.sh
# Find active critical errors in the System Event Log (SEL).
#
# Usage:
#   ./03-sel_find_active_errors.sh <BMC_IP> <PASSWORD> [LOG_FILE]
#   ./03-sel_find_active_errors.sh               (local ipmitool)
#   ipmitool sel elist | ./03-sel_find_active_errors.sh
#
# Output:
#   [LOG_FILE]  - full SEL dump and analysis (stdout + stderr), if provided

set -euo pipefail

BMC_USER="ADMIN"
# Maximum number of SEL entries to fetch.
# ipmitool fetches entries one-at-a-time; limiting this is the single biggest
# speed improvement for large SELs. Increase if the AC power-on marker
# (Unknown #0xff) is not found within this window.
SEL_FETCH_LIMIT="${SEL_FETCH_LIMIT:-500}"
# IPMI options: lanplus = IPMI 2.0 RMCP+ (faster than default lan/IPMI 1.5);
# -N 3 = 3-second UDP timeout; -R 2 = 2 retries (defaults: -N 2 -R 4)
IPMI_OPTS=(-I lanplus -N 3 -R 2)

usage() {
    echo "Usage: $0 <BMC_IP> <PASSWORD> [LOG_FILE]" >&2
    echo "       $0                   (local ipmitool)" >&2
    echo "       ipmitool sel elist | $0" >&2
    exit 1
}

if [[ $# -ge 2 ]]; then
    BMC_IP="$1"
    BMC_PWD="$2"
    LOG_FILE="${3:-}"
elif [[ $# -eq 0 ]]; then
    BMC_IP=""
    BMC_PWD=""
    LOG_FILE=""
else
    usage
fi

if [[ -n "$LOG_FILE" ]]; then
    mkdir -p "$(dirname "$LOG_FILE")"
    exec > >(tee "$LOG_FILE") 2>&1
fi

# Temporarily disable pipefail for command substitution
set +e
# Read SEL input (from stdin or ipmitool)
if [ -n "$BMC_IP" ]; then
  # Remote ipmitool call (has BMC credentials)
  SEL_OUTPUT=$(ipmitool "${IPMI_OPTS[@]}" -H "$BMC_IP" -U "$BMC_USER" -P "$BMC_PWD" \
    sel elist last "$SEL_FETCH_LIMIT" 2>&1)
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    echo "Error: ipmitool command failed" >&2
    echo "${SEL_OUTPUT}" >&2
    exit 2
  fi

  if [ -z "$SEL_OUTPUT" ]; then
    echo "Error: SEL_OUTPUT is empty" >&2
    exit 2
  fi
elif [ -t 0 ]; then
  # No BMC IP and stdin is a terminal - try local ipmitool
  SEL_OUTPUT=$(ipmitool "${IPMI_OPTS[@]}" sel elist last "$SEL_FETCH_LIMIT" 2>&1)
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ] || [ -z "$SEL_OUTPUT" ]; then
    echo "Error: Failed to retrieve SEL data from local IPMI interface" >&2
    echo "ipmitool output: $SEL_OUTPUT" >&2
    echo "Please check if ipmitool is installed and IPMI interface is available" >&2
    exit 2
  fi
else
  # No BMC IP and stdin is piped - read from stdin
  SEL_OUTPUT=$(cat)
fi
set -e

# Print the SEL log for visibility
echo "=== System Event Log (SEL) ==="
if [ -n "${SEL_OUTPUT:-}" ]; then
  echo "$SEL_OUTPUT"
else
  echo "(empty)"
fi
echo ""

# Single-pass analysis: locate the AC power-on boundary, print the post-boundary
# events, then tally net-asserted critical/failure events — all in one awk run.
# Format: ID | Date | Time | Component | Event | Status | Details
awk -F'|' -v FETCH_LIMIT="$SEL_FETCH_LIMIT" '
BEGIN { last_ff = 0 }
{ lines[NR] = $0; if ($0 ~ /Unknown #0xff/) last_ff = NR }
END {
  start = last_ff + 1   # when last_ff==0, start==1 → analyse all lines

  if (last_ff > 0) {
    print "=== Found AC power on event (Unknown #0xff) at line " last_ff \
          ", analyzing events after this point ==="
    print "Events after last AC power on:"
    for (i = start; i <= NR; i++) print lines[i]
    print ""
  } else {
    print "=== No AC power on event entries found, analyzing all events ==="
    print "    (searched last " FETCH_LIMIT " entries; set SEL_FETCH_LIMIT to raise the window)"
  }

  for (i = start; i <= NR; i++) {
    line = lines[i]
    low  = tolower(line)
    if (low !~ /asserted/)         continue   # also skips non-deasserted lines
    if (low !~ /critical|failure/) continue

    n = split(line, f, "|")
    for (j = 1; j <= n; j++) gsub(/^[[:space:]]+|[[:space:]]+$/, "", f[j])

    desc = (f[5] != "" && f[5] != " ") ? f[4] " | " f[5] : f[4]
    if (low ~ /deasserted/) deasserted[desc]++
    else                    asserted[desc]++
  }

  count = 0
  for (d in asserted) {
    net = asserted[d] - (d in deasserted ? deasserted[d] : 0)
    if (net > 0) count++
  }

  if (count == 0) { print "None found."; exit 0 }

  print "Active Failures:" > "/dev/stderr"
  for (d in asserted) {
    net = asserted[d] - (d in deasserted ? deasserted[d] : 0)
    if (net > 0) printf "  %s\n", d > "/dev/stderr"
  }
  exit 1
}
' <<< "$SEL_OUTPUT"
