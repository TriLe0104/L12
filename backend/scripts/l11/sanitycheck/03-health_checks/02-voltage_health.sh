#!/usr/bin/env bash
# 02-voltage_health.sh
# Collect voltage sensor health from Supermicro BMC Redfish API, write CSV and log.
#
# Usage:
#   ./02-voltage_health.sh <BMC_IP> <PASSWORD> <OUTPUT_CSV>
#   ./02-voltage_health.sh <BMC_IP> <PASSWORD> --raw
#
# Output (normal mode):
#   <OUTPUT_CSV>            - parsed voltage data in CSV format
#   <OUTPUT_CSV%.csv>.log   - full output log (stdout + stderr)

set -euo pipefail

BMC_USER="ADMIN"

usage() {
    echo "Usage: $0 <BMC_IP> <PASSWORD> <OUTPUT_CSV>" >&2
    echo "       $0 <BMC_IP> <PASSWORD> --raw" >&2
    exit 1
}

[[ $# -ne 3 ]] && usage

BMC_IP="$1"
BMC_PWD="$2"
CSV="$3"

if [[ "$CSV" == "--raw" ]]; then
    RAW_MODE=1
else
    RAW_MODE=0
    mkdir -p "$(dirname "$CSV")"
    LOG="${CSV%.csv}.log"
    exec > >(tee "$LOG") 2>&1
fi

RED_JSON=$(curl -s -k -u "$BMC_USER:$BMC_PWD" "https://$BMC_IP/redfish/v1/Chassis/1/Power")
if [[ -z "$RED_JSON" ]]; then
    echo "Error: Failed to fetch Redfish data from $BMC_IP" >&2
    exit 2
fi

if [[ $RAW_MODE -eq 1 ]]; then
    echo "$RED_JSON" | jq '.Voltages'
    exit 0
fi

echo "Name,Reading_V,Min_Critical,Max_Critical,State,Health,Error" > "$CSV"

OVERALL_STATUS="OK"

echo "=== Voltage Details ==="
while read -r v; do
    NAME=$(echo "$v" | jq -r '.Name')
    READING=$(echo "$v" | jq -r '.ReadingVolts')
    MIN=$(echo "$v" | jq -r '.LowerThresholdCritical // "null"')
    MAX=$(echo "$v" | jq -r '.UpperThresholdCritical // "null"')
    STATE=$(echo "$v" | jq -r '.Status.State')
    HEALTH=$(echo "$v" | jq -r '.Status.Health')

    ERROR="OK"
    if [[ "$HEALTH" != "OK" ]]; then
        ERROR="HealthNotOK"
    elif [[ "$MIN" != "null" && "$MAX" != "null" ]]; then
        if (( $(awk "BEGIN {print ($READING < $MIN || $READING > $MAX)}") )); then
            ERROR="ReadingOutOfRange"
        fi
    elif (( $(awk "BEGIN {print ($READING==0)}") )); then
        ERROR="ZeroValue"
    fi

    if [[ "$ERROR" != "OK" ]]; then
        echo "$NAME: Error - $ERROR" >&2
        echo "  Reading: $READING V, Min: $MIN, Max: $MAX" >&2
        echo "  State: $STATE, Health: $HEALTH" >&2
        echo "" >&2
        OVERALL_STATUS="Error"
    else
        echo "$NAME: OK"
        echo "  Reading: $READING V, Min: $MIN, Max: $MAX"
        echo "  State: $STATE, Health: $HEALTH"
        echo ""
    fi

    echo "$NAME,$READING,$MIN,$MAX,$STATE,$HEALTH,$ERROR" >> "$CSV"
done < <(echo "$RED_JSON" | jq -c '.Voltages[]')

echo "Voltage log written to $CSV"

if [[ "$OVERALL_STATUS" == "Error" ]]; then
    echo "FAIL: One or more voltage sensors reported an error." >&2
    exit 3
fi
echo "PASS: All voltage sensors are OK."