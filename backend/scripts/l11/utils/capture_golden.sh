#!/bin/bash
# Capture golden reference files (BOM, firmware, software) from a single node.
# Usage: capture_golden.sh <log_dir> <sys_sn> <os_ip> <bmc_ip> <bmc_pwd>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common/colors.sh"

if [[ "$#" -ne 5 ]]; then
    echo "Usage: $0 <log_dir> <sys_sn> <os_ip> <bmc_ip> <bmc_pwd>" >&2
    exit 1
fi

LOG_DIR="$1"
SYS_SN="$2"
OS_IP="$3"
BMC_IP="$4"
BMC_PWD="$5"

TRILSANITYCHK_SCRIPT="$SCRIPT_DIR/../sanitycheck/02-bom_checks/01-trilsanitychk.sh"
FW_CHECK_SCRIPT="$SCRIPT_DIR/../sanitycheck/01-fw-sw_checks/01-firmwareinventoryinfo.sh"
SW_CHECK_SCRIPT="$SCRIPT_DIR/../sanitycheck/01-fw-sw_checks/02-software_capture.sh"
DATA_DIR="$SCRIPT_DIR/../data"
GOLDEN_BOM="$DATA_DIR/bom_golden.json"
GOLDEN_LOG="$DATA_DIR/golden_capture.log"

mkdir -p "$DATA_DIR" "$LOG_DIR"

# Re-exec with tee so the full output (stdout+stderr) is saved to the log file
if [[ -z "$_CAPTURE_GOLDEN_LOGGING" ]]; then
    export _CAPTURE_GOLDEN_LOGGING=1
    exec > >(tee "$GOLDEN_LOG") 2>&1
fi

echo "Golden capture started: $(date)"
echo "  SYS SN: $SYS_SN | OS IP: $OS_IP | BMC IP: $BMC_IP"
echo ""

OVERALL_EXIT=0

# --- BOM golden ---
echo -e "${GREEN}Capturing Golden BOM...${RESET}"
echo "  OS IP:  $OS_IP"
echo "  BMC IP: $BMC_IP"
echo ""
bash "$TRILSANITYCHK_SCRIPT" --host "$OS_IP" --bmc-pwd "$BMC_PWD" --export "$GOLDEN_BOM"
BOM_EXIT=$?
if [[ $BOM_EXIT -eq 0 ]]; then
    echo -e "${GREEN}${CHECK} Golden BOM captured: $GOLDEN_BOM${RESET}"
elif [[ $BOM_EXIT -eq 114514 ]]; then
    echo -e "${YELLOW}${WARN} Golden BOM capture skipped (no existing golden to compare)${RESET}"
else
    echo -e "${RED}${CROSS} Failed to capture Golden BOM (exit: $BOM_EXIT)${RESET}"
    OVERALL_EXIT=1
fi

echo ""

# --- Firmware golden ---
echo -e "${GREEN}Capturing Golden Firmware (SN: $SYS_SN)...${RESET}"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
bash "$FW_CHECK_SCRIPT" --golden "$LOG_DIR" "$SYS_SN" "$BMC_IP" "$BMC_PWD" "$TIMESTAMP"
FW_EXIT=$?
if [[ $FW_EXIT -eq 0 || $FW_EXIT -eq 82 ]]; then
    echo -e "${GREEN}${CHECK} Golden Firmware captured${RESET}"
else
    echo -e "${RED}${CROSS} Failed to capture Golden Firmware (exit: $FW_EXIT)${RESET}"
    OVERALL_EXIT=1
fi

echo ""

# --- Software golden ---
echo -e "${GREEN}Capturing Golden Software...${RESET}"
SW_TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
bash "$SW_CHECK_SCRIPT" --golden "$LOG_DIR" "$OS_IP" "$SW_TIMESTAMP"
SW_EXIT=$?
if [[ $SW_EXIT -eq 0 || $SW_EXIT -eq 82 ]]; then
    echo -e "${GREEN}${CHECK} Golden Software captured${RESET}"
else
    echo -e "${RED}${CROSS} Failed to capture Golden Software (exit: $SW_EXIT)${RESET}"
    OVERALL_EXIT=1
fi

echo ""
echo "Golden capture finished: $(date) | log: $GOLDEN_LOG"
exit $OVERALL_EXIT
