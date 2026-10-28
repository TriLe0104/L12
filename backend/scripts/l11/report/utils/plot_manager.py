import os
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from typing import Dict, List, Set


class PlotManager:
    """Handles plotting functionality for sensor data."""

    def __init__(self, rack_path: str, headers: List[str], group_map: Dict[str, List[str]],
                 rack_folders_ordered: List[str], sensor_min: Dict[str, List[float]],
                 sensor_max: Dict[str, List[float]], show_serial_numbers: bool = True):
        self.rack_path = rack_path
        self.plot_dir = os.path.join(self.rack_path, 'min_max_plots')
        os.makedirs(self.plot_dir, exist_ok=True)
        self.headers = headers
        self.group_map = group_map
        self.rack_folders_ordered = rack_folders_ordered
        self.sensor_min = sensor_min
        self.sensor_max = sensor_max
        self.show_serial_numbers = show_serial_numbers

    def plot_all(self, included_groups: Set[str]) -> None:
        """Generate min/max bar charts for all included sensor groups."""
        # For L10 (single node), create combined plots per category
        # For L11 (multiple nodes), create individual plots per sensor
        is_single_node = len(self.rack_folders_ordered) == 1
        
        if is_single_node:
            # Clean up any old L11-style individual sensor plots
            self._cleanup_individual_plots()
            self._plot_combined_by_group(included_groups)
        else:
            # Clean up any old L10-style group plots
            self._cleanup_group_plots()
            self._plot_individual_sensors(included_groups)
    
    def _cleanup_group_plots(self) -> None:
        """Delete old L10-style combined group plots."""
        import glob
        # Pattern for group plots: they don't have units in the filename like individual sensors do
        # Group plots: "CPU_Temperatures_min_max.png", "Fan_Speeds_min_max.png", "System_Power_min_max.png"
        # Individual plots: "CPU1_Temp_°C_min_max.png", "Fan_1_RPM_min_max.png"
        for group_file_pattern in ['*_Temperatures_min_max.png', '*_Speeds_min_max.png', 
                                   '*_Voltages_min_max.png', '*_Power_min_max.png',
                                   '*_Efficiency_min_max.png']:
            for filepath in glob.glob(os.path.join(self.plot_dir, group_file_pattern)):
                try:
                    os.remove(filepath)
                except Exception:
                    pass
    
    def _cleanup_individual_plots(self) -> None:
        """Delete old L11-style individual sensor plots."""
        import glob
        # Remove all plots except group plots
        for filepath in glob.glob(os.path.join(self.plot_dir, '*_min_max.png')):
            # Keep files that match group patterns
            basename = os.path.basename(filepath)
            is_group_plot = any(pattern in basename for pattern in 
                              ['_Temperatures_min_max.png', '_Speeds_min_max.png', 
                               '_Voltages_min_max.png', '_Power_', '_Efficiency_min_max.png'])
            if not is_group_plot:
                try:
                    os.remove(filepath)
                except Exception:
                    pass
    
    def _plot_individual_sensors(self, included_groups: Set[str]) -> None:
        """Generate individual min/max bar charts for each sensor (L11 mode)."""
        skipped = []
        # Only plot headers in included groups
        included_headers = set()
        for group in included_groups:
            included_headers.update(self.group_map.get(group, []))

        for h in self.headers:
            if h not in included_headers:
                continue
            min_vals = self.sensor_min[h]
            max_vals = self.sensor_max[h]
            if all(pd.isna(min_vals)) and all(pd.isna(max_vals)):
                print(f"Warning: No data for column '{h}', skipping PNG generation.")
                skipped.append(h)
                continue

            plt.figure(figsize=(12, 6))
            x = self.rack_folders_ordered
            bar_width = 0.35
            idx = range(len(x))
            min_bars = plt.bar([i - bar_width/2 for i in idx], min_vals, bar_width, color='skyblue', label='Min')
            max_bars = plt.bar([i + bar_width/2 for i in idx], max_vals, bar_width, color='salmon', label='Max')

            # Add value labels on top of bars
            for i, bar in enumerate(min_bars):
                val = min_vals[i]
                if not pd.isna(val):
                    plt.text(bar.get_x() + bar.get_width()/2, bar.get_height(), f'{val:.1f}', ha='center', va='bottom', fontsize=8, color='blue')
            for i, bar in enumerate(max_bars):
                val = max_vals[i]
                if not pd.isna(val):
                    plt.text(bar.get_x() + bar.get_width()/2, bar.get_height(), f'{val:.1f}', ha='center', va='bottom', fontsize=8, color='red')

            if self.show_serial_numbers:
                plt.xticks(idx, x, rotation=45, ha='right')
            else:
                plt.xticks(idx, [''] * len(x))
            plt.ylabel(h)
            plt.title(f'{h}')
            plt.legend(loc='upper right')
            plt.tight_layout()

            out_path = os.path.join(self.plot_dir, f'{h.replace("/", "_").replace(" ", "_").replace("(", "").replace(")", "")}_min_max.png')
            plt.savefig(out_path, dpi=150)
            plt.close()

        if skipped:
            print(f"Skipped columns (no data): {', '.join(skipped)}")
        else:
            print('All min/max barcharts exported as PNGs.')
    
    def _plot_combined_by_group(self, included_groups: Set[str]) -> None:
        """Generate combined plots with all sensors in a group (L10 mode)."""
        import re
        
        for group in included_groups:
            sensors = self.group_map.get(group, [])
            if not sensors:
                continue
            
            # Filter sensors that have data
            valid_sensors = []
            min_values = []
            max_values = []
            
            for sensor in sensors:
                if sensor not in self.sensor_min:
                    continue
                min_val = self.sensor_min[sensor][0] if len(self.sensor_min[sensor]) > 0 else None
                max_val = self.sensor_max[sensor][0] if len(self.sensor_max[sensor]) > 0 else None
                
                if not pd.isna(min_val) or not pd.isna(max_val):
                    valid_sensors.append(sensor)
                    min_values.append(min_val if not pd.isna(min_val) else 0)
                    max_values.append(max_val if not pd.isna(max_val) else 0)
            
            if not valid_sensors:
                print(f"Warning: No data for group '{group}', skipping PNG generation.")
                continue
            
            # Extract unit from sensor names (e.g., "Temperature (°C)" -> "°C")
            unit = None
            unit_match = re.search(r'\(([^)]+)\)$', valid_sensors[0])
            if unit_match:
                unit = unit_match.group(1)
            
            # Remove unit from sensor names for x-axis labels
            sensor_labels = []
            for sensor in valid_sensors:
                label = re.sub(r'\s*\([^)]+\)$', '', sensor)
                sensor_labels.append(label)
            
            # Create combined plot
            plt.figure(figsize=(14, 6))
            bar_width = 0.35
            idx = range(len(valid_sensors))
            
            min_bars = plt.bar([i - bar_width/2 for i in idx], min_values, bar_width, color='skyblue', label='Min')
            max_bars = plt.bar([i + bar_width/2 for i in idx], max_values, bar_width, color='salmon', label='Max')
            
            # Add value labels on top of bars with larger font
            for i, bar in enumerate(min_bars):
                val = min_values[i]
                if val != 0:
                    plt.text(bar.get_x() + bar.get_width()/2, bar.get_height(), f'{val:.1f}', ha='center', va='bottom', fontsize=10, color='blue')
            for i, bar in enumerate(max_bars):
                val = max_values[i]
                if val != 0:
                    plt.text(bar.get_x() + bar.get_width()/2, bar.get_height(), f'{val:.1f}', ha='center', va='bottom', fontsize=10, color='red')
            
            plt.xticks(idx, sensor_labels, rotation=45, ha='right', fontsize=10)
            # Use extracted unit in y-axis label
            y_label = unit if unit else 'Value'
            plt.ylabel(y_label, fontsize=12)
            # No title for L10 plots
            plt.legend(loc='upper right', fontsize=10)
            plt.tight_layout()
            
            out_path = os.path.join(self.plot_dir, f'{group.replace("/", "_").replace(" ", "_").replace("(", "").replace(")", "")}_min_max.png')
            plt.savefig(out_path, dpi=150)
            plt.close()
        
        print('All combined group charts exported as PNGs for L10 report.')