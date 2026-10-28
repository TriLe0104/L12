#!/usr/bin/env bash
# 01-psu_health.sh
# Collect PSU health from Supermicro BMC Redfish API, write CSV and log.
#
# Usage:
#   ./01-psu_health.sh <BMC_IP> <PASSWORD> <OUTPUT_CSV>
#   ./01-psu_health.sh <BMC_IP> <PASSWORD> --raw
#
# Output (normal mode):
#   <OUTPUT_CSV>            - parsed PSU data in CSV format
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
    echo "$RED_JSON" | jq '.PowerSupplies'
    exit 0
fi

echo "PSU,SerialNumber,PartNumber,FirmwareVersion,Status,Health,InputVoltage_V,InputPower_W,InputCurrent_A,OutputPower_W,Capacity_W,Efficiency_percent,Error" > "$CSV"

TOTAL_IN=0
TOTAL_OUT=0
OVERALL_STATUS="OK"

echo "=== PSU Details ==="

while read -r psu; do
    NAME=$(echo "$psu" | jq -r '.Name')
    SERIAL=$(echo "$psu" | jq -r '.SerialNumber // "N/A"')
    PART_NUM=$(echo "$psu" | jq -r '.PartNumber // "N/A"')
    FW_VER=$(echo "$psu" | jq -r '.FirmwareVersion // "N/A"')
    STATUS=$(echo "$psu" | jq -r '.Status.State')
    HEALTH=$(echo "$psu" | jq -r '.Status.Health')
    INPUT_V=$(echo "$psu" | jq -r '.LineInputVoltage')
    INPUT_P=$(echo "$psu" | jq -r '.PowerInputWatts')
    OUTPUT_P=$(echo "$psu" | jq -r '.PowerOutputWatts')
    CAPACITY=$(echo "$psu" | jq -r '.PowerCapacityWatts // .InputRanges[0].OutputWattage // "null"')
    MAX_V=$(echo "$psu" | jq -r '.InputRanges[0].MaximumVoltage // "null"')
    MIN_V=$(echo "$psu" | jq -r '.InputRanges[0].MinimumVoltage // "null"')

    if [[ "$INPUT_V" != "null" && "$INPUT_V" != "0" ]]; then
        INPUT_I=$(awk "BEGIN {printf \"%.2f\", $INPUT_P / $INPUT_V}")
    else
        INPUT_I="0"
    fi

    if [[ "$INPUT_P" != "0" ]]; then
        EFF=$(awk "BEGIN {printf \"%.2f\", ($OUTPUT_P/$INPUT_P)*100}")
    else
        EFF="0"
    fi

    ERROR="OK"
    if [[ "$HEALTH" != "OK" ]]; then
        ERROR="HealthNotOK"
    elif (( $(awk "BEGIN {print ($OUTPUT_P > $INPUT_P)}") )); then
        ERROR="OutputExceedsInput-PossibleSensorFault"
    elif (( $(awk "BEGIN {print ($INPUT_V==0 || $INPUT_P==0 || $OUTPUT_P==0)}") )); then
        ERROR="ZeroValue"
    fi

    if [[ "$CAPACITY" != "null" ]]; then
        if (( $(awk "BEGIN {print ($OUTPUT_P > $CAPACITY)}") )); then
            ERROR="OutputExceedsCapacity"
        fi
    fi

    if [[ "$ERROR" != "OK" ]]; then
        echo "$NAME: Error - $ERROR" >&2
        echo "  Status: $STATUS, Health: $HEALTH, Serial: $SERIAL" >&2
        echo "  Part: $PART_NUM, FW: $FW_VER" >&2
        if [[ "$MAX_V" != "null" && "$MIN_V" != "null" ]]; then
            echo "  Input:  Power=${INPUT_P}W, Voltage=${INPUT_V}V (${MIN_V}V-${MAX_V}V), Current=${INPUT_I}A" >&2
        else
            echo "  Input:  Power=${INPUT_P}W, Voltage=${INPUT_V}V, Current=${INPUT_I}A" >&2
        fi
        echo "  Output: Power=${OUTPUT_P}W, Capacity=${CAPACITY}W, Efficiency=${EFF}%" >&2
        echo "" >&2
        OVERALL_STATUS="Error"
    else
        echo "$NAME: OK"
        echo "  Status: $STATUS, Health: $HEALTH, Serial: $SERIAL"
        echo "  Part: $PART_NUM, FW: $FW_VER"
        if [[ "$MAX_V" != "null" && "$MIN_V" != "null" ]]; then
            echo "  Input:  Power=${INPUT_P}W, Voltage=${INPUT_V}V (${MIN_V}V-${MAX_V}V), Current=${INPUT_I}A"
        else
            echo "  Input:  Power=${INPUT_P}W, Voltage=${INPUT_V}V, Current=${INPUT_I}A"
        fi
        echo "  Output: Power=${OUTPUT_P}W, Capacity=${CAPACITY}W, Efficiency=${EFF}%"
        echo ""
    fi

    echo "$NAME,$SERIAL,$PART_NUM,$FW_VER,$STATUS,$HEALTH,$INPUT_V,$INPUT_P,$INPUT_I,$OUTPUT_P,$CAPACITY,$EFF,$ERROR" >> "$CSV"
    TOTAL_IN=$(awk "BEGIN {print $TOTAL_IN+$INPUT_P}")
    TOTAL_OUT=$(awk "BEGIN {print $TOTAL_OUT+$OUTPUT_P}")
done < <(echo "$RED_JSON" | jq -c '.PowerSupplies[]')

if (( $(awk "BEGIN {print ($TOTAL_IN>0)}") )); then
    TOTAL_EFF=$(awk "BEGIN {printf \"%.2f\", ($TOTAL_OUT/$TOTAL_IN)*100}")
else
    TOTAL_EFF="0"
fi

echo "=== Overall Power Summary ==="
echo "Total Power In:  ${TOTAL_IN} W"
echo "Total Power Out: ${TOTAL_OUT} W"
echo "Overall Efficiency: ${TOTAL_EFF} %"
echo "Overall Status: $OVERALL_STATUS"

echo "Overall,N/A,N/A,N/A,$OVERALL_STATUS,$OVERALL_STATUS,N/A,$TOTAL_IN,N/A,$TOTAL_OUT,N/A,$TOTAL_EFF,$OVERALL_STATUS" >> "$CSV"
echo "PSU log written to $CSV"

if [[ "$OVERALL_STATUS" == "Error" ]]; then
    echo "FAIL: One or more PSUs reported an error." >&2
    exit 3
fi
echo "PASS: All PSUs are OK."
