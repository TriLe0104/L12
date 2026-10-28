#!/bin/bash
# lib/colors.sh - Standard ANSI color constants and status indicator symbols
# Source this file for consistent terminal color output across all scripts.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/colors.sh"    # from another common file
#   source "$SCRIPT_DIR/common/colors.sh"                # from project root scripts
#   source "$LIB_DIR/colors.sh"                          # from scripts with LIB_DIR set

GREEN=$'\e[32m'
YELLOW=$'\e[33m'
RED=$'\e[31m'
BLUE=$'\e[34m'
WHITE=$'\e[37m'
CYAN=$'\e[36m'
RESET=$'\e[0m'
NC=$'\e[0m'  # alias for RESET, used in parser scripts

CHECK="✔"
WARN="⚠"
CROSS="✘"
NONE=" "
