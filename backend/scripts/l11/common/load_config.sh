#!/bin/bash
# load_config.sh - Helper function to load project configuration from JSON
# Usage: source load_config.sh

load_config() {
    local script_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    local config_file="$script_dir/proj.json"
    
    if [[ ! -f "$config_file" ]]; then
        echo "Configuration file not found. Creating template at $config_file" >&2
        cat > "$config_file" << 'EOF'
{
  "project_name": "",
  "proj_display_name": "",
  "subnet_mask": "255.255.0.0",
  "default_gateway": "192.168.1.1",
  "ip_range": "192.168.8.1-192.168.15.255",
  "arp_interface": "eno2"
}
EOF
        echo "Please edit $config_file with your settings." >&2
        return 1
    fi

    # Check if jq is available
    if ! command -v jq &> /dev/null; then
        echo "Error: jq is required to parse JSON configuration" >&2
        echo "Install with: sudo apt-get install jq" >&2
        return 1
    fi

    # Parse JSON configuration
    local project_name=$(jq -r '.project_name // empty' "$config_file" 2>/dev/null)
    local proj_display_name=$(jq -r '.proj_display_name // empty' "$config_file" 2>/dev/null)
    local ip_range=$(jq -r '.ip_range // empty' "$config_file" 2>/dev/null)
    local arp_interface=$(jq -r '.arp_interface // empty' "$config_file" 2>/dev/null)
    local netmask=$(jq -r '.subnet_mask // empty' "$config_file" 2>/dev/null)
    local default_gateway=$(jq -r '.default_gateway // empty' "$config_file" 2>/dev/null)

    # Validate JSON parsing
    if [[ $? -ne 0 ]]; then
        echo "Error: Invalid JSON format in $config_file" >&2
        return 1
    fi

    # Export new variables
    export PROJ_NAME="$project_name"
    export PROJ_DISPLAY_NAME="$proj_display_name"
    export IP_RANGE="$ip_range"
    export ARP_IF="$arp_interface"
    export NETMASK="$netmask"
    export DEFGW="$default_gateway"

    # Validate required configuration
    if [[ -z "$PROJ_NAME" ]]; then
        echo "Error: project_name is required in proj.json" >&2
        return 1
    fi

    return 0
}
