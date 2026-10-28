import os
import sys
import csv
import glob
import pandas as pd
from collections import defaultdict
from typing import List, Dict, Optional, Tuple, Set, Any

from .data_parser import parse_log_file, parse_software_report_csv



class DataManager:
    """Handles all data collection and processing for sensor and test reports."""

    # Special sections to combine across nodes
    SPECIAL_SECTIONS = [
        "Firmware Version of L10 Server",
        "Hardware Version of L10 Server",
        "Software Version of L10 Server"
    ]

    def __init__(self, rack_path: str):
        self.rack_path = os.path.abspath(rack_path)
        self.hostfile_path = self._find_latest_hostfile()
        self.rack_serial_order = self._get_rack_serial_order()
        self.rack_folders_ordered = self._get_rack_folders_ordered()
        self.headers = self._get_headers()
        self.group_map = self._group_headers()
    def find_files_recursive(self, directory: str, pattern: str) -> List[str]:
        """Find files matching a pattern recursively in a directory.
        
        Args:
            directory: Directory to search in recursively
            pattern: File pattern to match
            
        Returns:
            List of paths to matching files
        """
        return glob.glob(os.path.join(directory, '**', pattern), recursive=True)

    def _find_latest_hostfile(self) -> str:
        """Find the latest hostfile*.csv in the rack directory.
        
        Returns:
            Path to the latest hostfile CSV
        """
        hostfiles = glob.glob(os.path.join(self.rack_path, 'hostfile*.csv'))
        if not hostfiles:
            raise FileNotFoundError(f"No hostfile*.csv found in {self.rack_path}")
        # Return the most recently modified file
        return max(hostfiles, key=os.path.getmtime)

    def _get_rack_serial_order(self) -> List[str]:
        """Get the order of rack serial numbers from hostfile.csv."""
        df = pd.read_csv(self.hostfile_path)
        return list(df['System_SN'])

    def _get_rack_folders_ordered(self) -> List[str]:
        """Get rack folders in the order specified by rack_serial_order."""
        rack_folders = [
            f for f in os.listdir(self.rack_path)
            if os.path.isdir(os.path.join(self.rack_path, f)) and f.startswith('S')
        ]
        return [sn for sn in self.rack_serial_order if sn in rack_folders]

    def _get_headers(self) -> List[str]:
        """Extract headers from a sample CSV file."""
        sample_csv = None
        for folder in self.rack_folders_ordered:
            print(f"Looking for sample CSV in folder: {folder}")
            sensor_folder = os.path.join(self.rack_path, folder, '103sensor')
            if not os.path.isdir(sensor_folder):
                continue
            for file in os.listdir(sensor_folder):
                if file.startswith('redfish_data_') and file.endswith('.csv'):
                    sample_csv = os.path.join(sensor_folder, file)
                    break
            if sample_csv:
                break
        if not sample_csv:
            print('Warning: No sensor CSV found. Sensor section will be skipped.', file=sys.stderr)
            return []
        df_sample = pd.read_csv(sample_csv)
        return [h for h in df_sample.columns if h not in ['Elapsed (ms)', 'Timestamp']]

    def _get_summary_csv_path(self) -> str:
        """Get the path for the min/max summary CSV file with timestamp."""
        from datetime import datetime
        summary_dir = os.path.join(self.rack_path, 'summary_report')
        os.makedirs(summary_dir, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        return os.path.join(summary_dir, f'sensor_min_max_summary_{timestamp}.csv')

    def _save_min_max_summary(self, sensor_min: Dict[str, List[float]], 
                               sensor_max: Dict[str, List[float]]) -> None:
        """Save min/max summary to CSV file."""
        summary_path = self._get_summary_csv_path()
        
        # Create DataFrame with node names as columns
        data: Dict[str, Any] = {'Sensor': self.headers}
        for i, node in enumerate(self.rack_folders_ordered):
            data[f'{node}_min'] = [sensor_min[h][i] for h in self.headers]
            data[f'{node}_max'] = [sensor_max[h][i] for h in self.headers]
        
        df = pd.DataFrame(data)
        df.to_csv(summary_path, index=False)
        print(f"Saved min/max summary to: {summary_path}")

    def get_sensor_min_max(self) -> Tuple[Dict[str, List[float]], Dict[str, List[float]]]:
        """Calculate and save min/max values for all sensor headers across all nodes.
            
        Returns:
            Tuple of (sensor_min, sensor_max) dictionaries
        """
        # Skip if no headers (no sensor data available)
        if not self.headers:
            print("No sensor data available. Skipping sensor min/max collection.", file=sys.stderr)
            return {}, {}
        
        # Calculate min/max values
        print("Calculating min/max values from sensor data...")
        sensor_min = {h: [] for h in self.headers}
        sensor_max = {h: [] for h in self.headers}
        
        for folder in self.rack_folders_ordered:
            sensor_folder = os.path.join(self.rack_path, folder, '103sensor')
            if not os.path.isdir(sensor_folder):
                for h in self.headers:
                    sensor_min[h].append(float('nan'))
                    sensor_max[h].append(float('nan'))
                continue
            csv_files = [f for f in os.listdir(sensor_folder) if f.startswith('redfish_data_') and f.endswith('.csv')]
            if not csv_files:
                for h in self.headers:
                    sensor_min[h].append(float('nan'))
                    sensor_max[h].append(float('nan'))
                continue
            
            # Read and concatenate all CSV files for this node
            all_dfs = []
            for csv_file in csv_files:
                csv_path = os.path.join(sensor_folder, csv_file)
                try:
                    df = pd.read_csv(csv_path)
                    all_dfs.append(df)
                except Exception as e:
                    print(f"Warning: Failed to read {csv_file} in {folder}: {e}", file=sys.stderr)
            
            if not all_dfs:
                for h in self.headers:
                    sensor_min[h].append(float('nan'))
                    sensor_max[h].append(float('nan'))
                continue
            
            # Concatenate all dataframes
            combined_df = pd.concat(all_dfs, ignore_index=True)
            
            # Calculate min/max across all files
            for h in self.headers:
                if h in combined_df.columns:
                    values = combined_df[h].dropna()
                    sensor_min[h].append(values.min() if not values.empty else float('nan'))
                    sensor_max[h].append(values.max() if not values.empty else float('nan'))
                else:
                    print(f"Error: Column '{h}' is present in other nodes but missing in {folder}'s CSV.")
                    sensor_min[h].append(float('nan'))
                    sensor_max[h].append(float('nan'))
        
        # Save the summary
        self._save_min_max_summary(sensor_min, sensor_max)
        
        return sensor_min, sensor_max

    def _group_headers(self) -> Dict[str, List[str]]:
        """Group headers into sensor categories matching generate_report.py logic."""
        groups = {
            'CPU Temperatures': [],
            'GPU Temperatures': [],
            'Memory (DIMM) Temperatures': [],
            'VRM Temperatures': [],
            'Storage Temperatures': [],
            'Network Card Temperatures': [],
            'PCIe/PLX Temperatures': [],
            'HGX Temperatures': [],
            'System Temperatures': [],
            'Fan Speeds': [],
            'Motherboard Voltages': [],
            'CPU Voltages': [],
            'System Power': [],
            'PSU Power (Input)': [],
            'PSU Power (Output)': [],
            'PSU Efficiency': []
        }
        for col in self.headers:
            if col.startswith('GPU') and 'Temp' in col:
                groups['GPU Temperatures'].append(col)
            elif 'HGX' in col and 'Temp' in col:
                groups['HGX Temperatures'].append(col)
            elif 'CPU' in col and 'Temp' in col and 'VRM' not in col:
                groups['CPU Temperatures'].append(col)
            elif 'DIMM' in col and 'Temp' in col:
                groups['Memory (DIMM) Temperatures'].append(col)
            elif 'VRM' in col and 'Temp' in col:
                groups['VRM Temperatures'].append(col)
            elif ('NVMe' in col or 'SSD' in col or 'SAS' in col or 'AOM_SAS' in col) and 'Temp' in col:
                groups['Storage Temperatures'].append(col)
            elif ('NIC' in col or 'AOC' in col or 'AOM_NIC' in col) and 'Temp' in col and 'PORTB' not in col and 'PORTA' not in col:
                groups['Network Card Temperatures'].append(col)
            elif ('PLX' in col or 'PCIe' in col or 'PORTA' in col or 'PORTB' in col) and 'Temp' in col:
                groups['PCIe/PLX Temperatures'].append(col)
            elif 'Temp' in col and col not in sum(groups.values(), []):
                groups['System Temperatures'].append(col)
            elif 'RPM' in col or 'Fan' in col:
                groups['Fan Speeds'].append(col)
            elif '(V)' in col:
                if 'Motherboard' in col:
                    groups['Motherboard Voltages'].append(col)
                elif 'CPU' in col:
                    groups['CPU Voltages'].append(col)
            elif '(W)' in col:
                if 'System Power Consumed' in col:
                    groups['System Power'].append(col)
                elif 'Input Power' in col:
                    groups['PSU Power (Input)'].append(col)
                elif 'Output Power' in col:
                    groups['PSU Power (Output)'].append(col)
            elif '(%)' in col:
                groups['PSU Efficiency'].append(col)
        # Remove empty groups
        return {k: v for k, v in groups.items() if v}

    def get_node_info(self) -> tuple[List[str], List[str]]:
        """Get all serial numbers from CSV and existing node folders."""
        csv_path = self.hostfile_path
        if not os.path.exists(csv_path):
            print(f"Hostfile not found: {csv_path}")
            return [], []

        print(f"Using hostfile: {os.path.basename(csv_path)}")
        with open(csv_path, 'r', newline='') as f:
            reader = csv.DictReader(f)
            all_sns = [row['System_SN'] for row in reader if row.get('System_SN')]

        existing_sns = [sn for sn in all_sns if os.path.isdir(os.path.join(self.rack_path, sn))]

        if not existing_sns:
            print("No matching node folders found in rack directory")

        return all_sns, existing_sns

    def collect_node_data(self, all_sns: List[str], existing_sns: List[str]) -> tuple[Dict[str, Dict], Dict[str, List], defaultdict]:
        """Collect parsed data for all nodes, separating combined and individual sections."""
        node_data = {}
        combined_data = {section: [] for section in self.SPECIAL_SECTIONS}
        all_sections = defaultdict(list)

        for sn in existing_sns:
            node_path = os.path.join(self.rack_path, sn)
            print(f"Processing node: {sn}")

            # Parse L10 file for sanity data
            sanity_logs_dir = os.path.join(node_path, '101infosystem')
            l10_files = self.find_files_recursive(sanity_logs_dir, '*.l10')

            parsed_data = {}
            if l10_files:
                latest_l10 = max(l10_files, key=os.path.getmtime)
                parsed_data = parse_log_file(latest_l10)

            # Parse software data
            software_data = parse_software_report_csv(node_path)
            if software_data:
                parsed_data["Software Version of L10 Server"] = software_data

            node_data[sn] = parsed_data

            # Collect data for combined sections and all sections
            for section_name, data_rows in parsed_data.items():
                if section_name in self.SPECIAL_SECTIONS:
                    for row in data_rows:
                        # Add serial number as first column only for Software Version (which doesn't have it)
                        if section_name == "Software Version of L10 Server":
                            row_with_sn = {"Serial Number": sn}
                            row_with_sn.update(row)
                            combined_data[section_name].append(row_with_sn)
                        else:
                            combined_data[section_name].append(row)
                else:
                    all_sections[section_name].append((sn, data_rows))

        # For combined sections, add empty rows for missing nodes
        for section_name in self.SPECIAL_SECTIONS:
            if combined_data[section_name]:
                headers = list(combined_data[section_name][0].keys())
                sn_to_index = {sn: i for i, sn in enumerate(all_sns)}
                
                # For Software Version, use "Serial Number" as the key; for others use first column
                sn_key = "Serial Number" if section_name == "Software Version of L10 Server" else headers[0]
                
                for sn in all_sns:
                    if not any(row.get(sn_key) == sn for row in combined_data[section_name]):
                        empty_row = {}
                        for i, h in enumerate(headers):
                            if (section_name == "Software Version of L10 Server" and h == "Serial Number") or \
                               (section_name != "Software Version of L10 Server" and i == 0):
                                empty_row[h] = sn
                            else:
                                empty_row[h] = ''
                        combined_data[section_name].append(empty_row)
                # Sort by SN order
                combined_data[section_name].sort(key=lambda row: sn_to_index.get(row.get(sn_key), len(all_sns)))

        return node_data, combined_data, all_sections