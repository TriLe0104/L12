# -*- coding: utf-8 -*-
"""
Data parsing module for L10 report generation.
Handles parsing of log files, CSV files, and extracting sensor/power data.
"""

import os
import glob
import csv
import re
from typing import Dict, List, Any, Optional, Union


def parse_log_file(log_path: str) -> Dict[str, List[Dict[str, str]]]:
    """Parse L10 log file and extract structured data.
    
    Args:
        log_path: Path to the L10 log file
        
    Returns:
        Dictionary containing parsed sections with their data rows
    """
    data: Dict[str, List[Dict[str, str]]] = {}
    current_section: Optional[str] = None
    headers: List[str] = []
    
    with open(log_path, "r", encoding="utf-8") as f:
        lines: List[str] = [line.strip() for line in f]
    
    i: int = 0
    while i < len(lines):
        line: str = lines[i]
        
        if line.startswith("Title:"):
            current_section = line[len("Title:"):].strip()
            data[current_section] = []
            headers = []
            i += 1
            continue
        
        if current_section and not headers and "," in line:
            headers = [h.strip() for h in line.split(",")]
            i += 1
            continue
        
        if current_section and headers and "," in line:
            row_values: List[str] = [v.strip() for v in line.split(",")]
            if len(row_values) < len(headers):
                i += 1
                continue
            row_dict: Dict[str, str] = dict(zip(headers, row_values))
            data[current_section].append(row_dict)
            i += 1
            continue
        
        i += 1
    
    return data


def parse_software_report_csv(node_path: str) -> Optional[List[Dict[str, str]]]:
    """Parse software report CSV file for a node.
    
    Args:
        node_path: Path to the node directory
        
    Returns:
        List of dictionaries containing software report data, or None if not found
    """
    try:
        info_system_dir: str = os.path.join(node_path, '101infosystem')
        # Look for directories matching pattern: 01-fw-sw_checks_*
        fw_check_dirs: List[str] = glob.glob(os.path.join(info_system_dir, '01-fw-sw_checks_*'))
        
        if not fw_check_dirs:
            return None
        
        # Get the latest directory by modification time
        latest_dir: str = max(fw_check_dirs, key=os.path.getmtime)
        
        # Look for CSV files matching pattern: 02-software_capture_*.csv
        csv_files: List[str] = glob.glob(os.path.join(latest_dir, '02-software_capture_*.csv'))
        
        if not csv_files:
            return None
        
        # Get the latest CSV file by modification time
        csv_path: str = max(csv_files, key=os.path.getmtime)
        
        with open(csv_path, mode='r', encoding='utf-8') as infile:
            reader = csv.DictReader(infile)
            rows = []
            for row in reader:
                # Find NIC columns where firmware version starts with "V000S4"
                nics_to_skip = set()
                for key, value in row.items():
                    if key.startswith("NIC #") and isinstance(value, str) and value.startswith("V000S4"):
                        # Extract NIC number (e.g., "NIC #1" -> "1")
                        nic_num = key.replace("NIC #", "").split()[0]
                        nics_to_skip.add(nic_num)
                
                # Filter out NIC columns and their corresponding driver/firmware columns
                filtered_row = {}
                for key, value in row.items():
                    skip = False
                    for nic_num in nics_to_skip:
                        if (key.startswith(f"NIC #{nic_num}") or 
                            key.startswith(f"NIC{nic_num}") or
                            (key.startswith("Driver") and f"#{nic_num}" in key) or
                            (key.startswith("Firmware") and f"#{nic_num}" in key)):
                            skip = True
                            break
                    if not skip:
                        filtered_row[key] = value
                rows.append(filtered_row)
            return rows
    
    except Exception:
        return None
