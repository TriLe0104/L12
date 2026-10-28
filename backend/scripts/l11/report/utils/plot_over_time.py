#!/usr/bin/env python3
"""
Combined Redfish Report Generator
Generates plots and PDF report from Redfish monitoring data
All outputs use timestamp from the input CSV file
"""

import pandas as pd
import matplotlib.pyplot as plt
import matplotlib
from datetime import datetime
import os
import sys
import json
import numpy as np
from pathlib import Path
import re
import argparse
import logging

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
matplotlib.use('Agg')  # Use Agg backend (no GUI, thread-safe)

try:
    from PIL import Image
    from reportlab.lib.pagesizes import letter, A4, landscape
    from reportlab.pdfgen import canvas
    from reportlab.lib.units import inch
except ImportError:
    logger.error("Required packages not installed.")
    logger.error("Please run: pip install Pillow reportlab pandas matplotlib")
    exit(1)


class PlotOverTime:
    """Combined report generator - creates plots and PDF in one go"""
    
    def __init__(self, data_file: str, thresholds_file: str, system_info_file: str, output_path: str, expected_serial: str):
        """
        Initialize report generator
        
        Args:
            data_file: Path to redfish_data CSV file
            thresholds_file: Path to redfish_thresholds CSV file
            system_info_file: Path to system_info.json file
            output_path: Path to directory where report will be created
            expected_serial: Expected system serial number (for validation)
        """
        self.data_file = data_file
        self.thresholds_file = thresholds_file
        self.system_info_file = system_info_file
        self.output_path = output_path
        self.expected_serial = expected_serial
        
        # Verify all input files exist
        if not os.path.exists(self.data_file):
            raise FileNotFoundError(f"Data file not found: {self.data_file}")
        if not os.path.exists(self.thresholds_file):
            raise FileNotFoundError(f"Thresholds file not found: {self.thresholds_file}")
        if not os.path.exists(self.system_info_file):
            raise FileNotFoundError(f"System info file not found: {self.system_info_file}")
        
        # Load and validate system info
        self.system_info = self._load_system_info(self.system_info_file)
        self.serial_number = self.system_info.get('SerialNumber', 'UNKNOWN_SERIAL')
        
        # Validate serial number
        if self.serial_number != expected_serial:
            raise ValueError(
                f"Serial number mismatch!\n"
                f"  Expected: {expected_serial}\n"
                f"  Found in system_info.json: {self.serial_number}\n"
                f"  Please verify the input path or expected serial number."
            )
        
        # Extract timestamp from data filename
        # Format: redfish_data_20251020_175322.csv
        self.timestamp = self._extract_timestamp(self.data_file)
        
        # Create output directory with timestamp
        # Create output directory with timestamp
        self.output_base_dir = os.path.join(output_path, f"redfish_report_{self.timestamp}")
        self.plots_dir = os.path.join(self.output_base_dir, "plots")
        
        # Create directories
        if not os.path.exists(self.output_base_dir):
            os.makedirs(self.output_base_dir)
        if not os.path.exists(self.plots_dir):
            os.makedirs(self.plots_dir)
        
        # PDF filename
        self.pdf_filename = os.path.join(self.output_base_dir, f"redfish_report_{self.timestamp}.pdf")
        # Load data
        logger.info(f"\n{'='*80}")
        logger.info(f"REDFISH REPORT GENERATOR")
        logger.info(f"{'='*80}")
        logger.info(f"Serial Number: {self.serial_number} (validated)")
        logger.info(f"Data file: {self.data_file}")
        logger.info(f"Output directory: {self.output_base_dir}")
        logger.info(f"Timestamp: {self.timestamp}")
        
        logger.info(f"\nLoading data from {self.data_file}...")
        self.data_df = pd.read_csv(self.data_file)
        
        logger.info(f"Loading thresholds from {self.thresholds_file}...")
        self.thresholds_df = pd.read_csv(self.thresholds_file)
        
        # Parse thresholds (MIN at index 0, MAX at index 1)
        self.min_thresholds = self.thresholds_df.iloc[0].to_dict()
        self.max_thresholds = self.thresholds_df.iloc[1].to_dict()
        
        logger.info(f"Loaded {len(self.data_df)} data points")
        logger.info(f"Sensors: {len(self.data_df.columns) - 2}")  # -2 for Elapsed and Timestamp
        
        # PDF settings
        self.page_size = landscape(letter)
        self.width, self.height = self.page_size
        
        # Define plot order - matches L10/L11 group order
        self.plot_order = [
            "CPU_Temperatures.png",
            "GPU_Temperatures.png",
            "Memory_(DIMM)_Temperatures.png",
            "VRM_Temperatures.png",
            "Storage_Temperatures.png",
            "Network_Card_Temperatures.png",
            "PCIe_PLX_Temperatures.png",
            "HGX_Temperatures.png",
            "System_Temperatures.png",
            "Fan_Speeds.png",
            "Motherboard_Voltages.png",
            "CPU_Voltages.png",
            "System_Power.png",
            "PSU_Power_(Input).png",
            "PSU_Power_(Output).png",
            "PSU_Efficiency.png"
        ]
    
    def _extract_timestamp(self, data_file: str) -> str:
        """Extract timestamp from data filename or use current time as fallback"""
        match = re.search(r'redfish_data_(\d{8}_\d{6})\.csv', os.path.basename(data_file))
        if match:
            return match.group(1)
        return datetime.now().strftime("%Y%m%d_%H%M%S")
    
    def _load_system_info(self, system_info_file: str) -> dict:
        """Load system information from system_info.json file"""
        try:
            with open(system_info_file, 'r', encoding='utf-8') as f:
                info = json.load(f)
                logger.info(f"Loaded system info: {info.get('Manufacturer', 'Unknown')} {info.get('Model', 'Unknown')}")
                logger.info(f"  Serial Number: {info.get('SerialNumber', 'Unknown')}")
                return info
        except Exception as e:
            logger.exception(f"Could not load system info from {system_info_file}: {e}")
            raise FileNotFoundError(f"Could not load system info from {system_info_file}: {e}")
    
    def _parse_timestamp_string(self, timestamp_str: str) -> str:
        """
        Parse timestamp string from CSV format to readable format
        """
        try:
            parts = timestamp_str.strip().split('_')
            if len(parts) == 2:
                date_part = parts[0]
                time_tz = parts[1]
                time_part = time_tz.split('.')[0].replace('-', ':')
                return f"{date_part} {time_part}"
        except Exception:
            pass
        return timestamp_str
    
    def _is_valid_threshold(self, threshold_value) -> bool:
        """Check if a threshold value is valid (not empty, not NaN)"""
        if not threshold_value or threshold_value == '':
            return False
        if str(threshold_value).lower() == 'nan':
            return False
        try:
            val = float(threshold_value)
            return not np.isnan(val)
        except (ValueError, TypeError):
            return False
    
    def _get_ylabel_for_group(self, group_name: str) -> str:
        """Get appropriate y-axis label based on sensor group name"""
        if 'Temp' in group_name:
            return 'Temperature (°C)'
        elif 'Fan' in group_name:
            return 'Speed (RPM)'
        elif 'Voltage' in group_name:
            return 'Voltage (V)'
        elif 'Efficiency' in group_name:
            return 'Efficiency (%)'
        elif 'Power' in group_name:
            return 'Power (W)'
        else:
            return 'Value'
    
    def get_sensor_groups(self):
        """Group sensors by type for plotting - matches L10/L11 grouping logic"""
        columns = [col for col in self.data_df.columns if col not in ['Elapsed (ms)', 'Timestamp']]

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

        for col in columns:
            # Temperature categorization - Order matters! Check GPU before HGX
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
    
    def check_violations(self, sensor_name: str, values: pd.Series):
        """Check if sensor has any threshold violations"""
        violations = []
        
        min_threshold = self.min_thresholds.get(sensor_name, '')
        max_threshold = self.max_thresholds.get(sensor_name, '')
        
        if min_threshold and min_threshold != '':
            try:
                min_val = float(min_threshold)
                below_min = values < min_val
                if below_min.any():
                    violations.append(f"Below MIN ({below_min.sum()} points)")
            except (ValueError, TypeError):
                pass
        
        if max_threshold and max_threshold != '':
            try:
                max_val = float(max_threshold)
                above_max = values > max_val
                if above_max.any():
                    violations.append(f"Above MAX ({above_max.sum()} points)")
            except (ValueError, TypeError):
                pass
        
        return violations
    
    def plot_group(self, group_name: str, sensors: list):
        """Plot a group of related sensors"""
        logger.info(f"  Plotting: {group_name} ({len(sensors)} sensors)")
        
        # Create figure
        fig, ax = plt.subplots(figsize=(14, 8))
        
        # Track violations for title
        has_violations = False
        violation_details = []
        
        # Get time axis (convert elapsed ms to seconds)
        time_seconds = self.data_df['Elapsed (ms)'] / 1000.0
        
        # Plot each sensor
        for sensor in sensors:
            if sensor not in self.data_df.columns:
                continue
            
            values = self.data_df[sensor]
            
            # Skip if all NaN
            if values.isna().all():
                continue
            
            # Check for violations
            violations = self.check_violations(sensor, values)
            if violations:
                has_violations = True
                violation_details.append(f"{sensor}: {', '.join(violations)}")
            
            # Calculate statistics
            valid_values = values.dropna()
            if len(valid_values) == 0:
                continue
            
            min_val = valid_values.min()
            max_val = valid_values.max()
            avg_val = valid_values.mean()
            
            # Plot data
            label = f"{sensor.split('(')[0].strip()} (min:{min_val:.1f}, max:{max_val:.1f}, avg:{avg_val:.1f})"
            line = ax.plot(time_seconds, values, label=label, linewidth=1.5, alpha=0.8)
            
            # Plot threshold lines with matching color
            sensor_color = line[0].get_color()
            
            min_threshold = self.min_thresholds.get(sensor, '')
            max_threshold = self.max_thresholds.get(sensor, '')
            
            # Draw MIN threshold if valid
            if self._is_valid_threshold(min_threshold):
                min_val_thresh = float(min_threshold)
                ax.axhline(y=min_val_thresh, color=sensor_color, linestyle='--', linewidth=1, 
                          alpha=0.4, label=f"  └─ MIN threshold: {min_val_thresh:.1f}")
            
            # Draw MAX threshold if valid
            if self._is_valid_threshold(max_threshold):
                max_val_thresh = float(max_threshold)
                ax.axhline(y=max_val_thresh, color=sensor_color, linestyle=':', linewidth=1, 
                          alpha=0.4, label=f"  └─ MAX threshold: {max_val_thresh:.1f}")
        
        # Set title with violation indicator
        title = group_name
        if has_violations:
            title += " ⚠ VIOLATIONS DETECTED"
            fig.patch.set_facecolor('#fff5f5')
        
        ax.set_title(title, fontsize=14, fontweight='bold', pad=20)
        ax.set_xlabel('Time (seconds)', fontsize=12)
        
        # Set y-axis label based on group type
        ax.set_ylabel(self._get_ylabel_for_group(group_name), fontsize=12)
        
        # Add grid
        ax.grid(True, alpha=0.3, linestyle='-', linewidth=0.5)
        
        # Legend
        ax.legend(bbox_to_anchor=(1.05, 1), loc='upper left', fontsize=8, 
                 framealpha=0.9, ncol=1)
        
        # Add violation details as text
        if violation_details:
            violation_text = "Violations:\n" + "\n".join(violation_details[:5])
            if len(violation_details) > 5:
                violation_text += f"\n... and {len(violation_details) - 5} more"
            ax.text(0.02, 0.98, violation_text, transform=ax.transAxes,
                   fontsize=8, verticalalignment='top',
                   bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.8))
        
        plt.tight_layout()
        
        # Save figure
        filename = f"{group_name.replace(' ', '_').replace('/', '_')}.png"
        filepath = os.path.join(self.plots_dir, filename)
        plt.savefig(filepath, dpi=150, bbox_inches='tight')
        
        # Close figure and free memory
        plt.close(fig)
        
        # Force garbage collection to free resources
        import gc
        gc.collect()
    
    def create_all_plots(self):
        """Create plots for all sensor groups"""
        logger.info(f"\n{'='*80}")
        logger.info("STEP 1: CREATING PLOTS")
        logger.info(f"{'='*80}")
        
        groups = self.get_sensor_groups()
        
        logger.info(f"\nGenerating {len(groups)} plot groups:")
        for group_name, sensors in groups.items():
            logger.info(f"  - {group_name}: {len(sensors)} sensors")
        
        # Create plots
        for group_name, sensors in groups.items():
            if sensors:
                self.plot_group(group_name, sensors)
        
        # Wait a moment to ensure all files are fully written to disk
        import time
        time.sleep(0.5)
        
        logger.info(f"\n✓ All plots saved to: {os.path.abspath(self.plots_dir)}")
    
    def get_data_info(self):
        """Extract information from the data file"""
        info = {
            'filename': os.path.basename(self.data_file),
            'size': os.path.getsize(self.data_file),
            'modified': datetime.fromtimestamp(os.path.getmtime(self.data_file))
        }
        
        # Count data points
        info['data_points'] = len(self.data_df) - 1  # Exclude header
        
        # Get first and last timestamps
        if len(self.data_df) > 0:
            first_line = self.data_df.iloc[0]
            last_line = self.data_df.iloc[-1]
            
            # Parse timestamps in format: 2025-10-19_23-40-38.582-0700
            info['start_time'] = self._parse_timestamp_string(str(first_line['Timestamp']))
            info['end_time'] = self._parse_timestamp_string(str(last_line['Timestamp']))
            
            # Calculate duration
            try:
                duration_ms = float(last_line['Elapsed (ms)'])
                duration_seconds = duration_ms / 1000.0
                info['duration_seconds'] = duration_seconds
                hours = int(duration_seconds // 3600)
                minutes = int((duration_seconds % 3600) // 60)
                seconds = int(duration_seconds % 60)
                info['duration_formatted'] = f"{hours}h {minutes}m {seconds}s"
            except:
                pass
        
        return info
    
    def create_title_page(self, c, data_info):
        """Create the title page with report information"""
        c.setFont("Helvetica-Bold", 24)
        c.drawCentredString(self.width / 2, self.height - inch, 
                           "Redfish Sensor Monitoring Report")
        
        c.setFont("Helvetica", 12)
        y = self.height - 2 * inch
        
        # System Information Section
        c.setFont("Helvetica-Bold", 14)
        c.drawCentredString(self.width / 2, y, "System Information")
        y -= 0.4 * inch
        
        c.setFont("Helvetica", 11)
        
        # Serial Number (prominent)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(1.5 * inch, y, f"Serial Number:")
        c.setFont("Helvetica", 11)
        c.drawString(3 * inch, y, self.serial_number)
        y -= 0.3 * inch
        
        # Manufacturer and Model
        manufacturer = self.system_info.get('Manufacturer', 'Unknown')
        model = self.system_info.get('Model', 'Unknown')
        c.drawString(1.5 * inch, y, f"System:")
        c.drawString(3 * inch, y, f"{manufacturer} {model}")
        y -= 0.3 * inch
        
        # BIOS Version
        bios_version = self.system_info.get('BiosVersion', 'Unknown')
        c.drawString(1.5 * inch, y, f"BIOS Version:")
        c.drawString(3 * inch, y, bios_version)
        y -= 0.5 * inch
        
        # Data file information
        if data_info:
            c.setFont("Helvetica-Bold", 14)
            c.drawCentredString(self.width / 2, y, "Monitoring Session Details")
            y -= 0.4 * inch
            c.setFont("Helvetica", 11)
            # Data file name
            c.drawString(1.5 * inch, y, f"Data File:")
            c.drawString(3 * inch, y, data_info['filename'])
            y -= 0.3 * inch
            # Duration
            if 'duration_formatted' in data_info:
                c.drawString(1.5 * inch, y, f"Duration:")
                c.drawString(3 * inch, y, data_info['duration_formatted'])
                y -= 0.3 * inch
            # Start/End time in one line
            if 'start_time' in data_info and 'end_time' in data_info:
                c.drawString(1.5 * inch, y, f"Time Range:")
                c.drawString(3 * inch, y, f"{data_info['start_time']} — {data_info['end_time']}")
                y -= 0.3 * inch
        
        # Plot information
        y -= 0.5 * inch
        c.setFont("Helvetica-Bold", 14)
        c.drawCentredString(self.width / 2, y, "Included Plots")
        y -= 0.4 * inch
        # Plot information
        y -= 0.5 * inch
        c.setFont("Helvetica-Bold", 14)
        c.drawCentredString(self.width / 2, y, "Included Plots")
        y -= 0.4 * inch
        
        c.setFont("Helvetica", 11)
        plot_descriptions = [
            "• CPU Temperatures",
            "• GPU Temperatures (GPU1-8)",
            "• Memory (DIMM) Temperatures",
            "• VRM (Voltage Regulator Module) Temperatures",
            "• Storage Device Temperatures",
            "• Network Card Temperatures",
            "• PCIe/PLX Bridge Temperatures",
            "• HGX System Temperatures",
            "• System and Peripheral Temperatures",
            "• Fan Speeds",
            "• Motherboard Voltage Rails",
            "• CPU Voltage Rails",
            "• System Power",
            "• PSU Power (Input)",
            "• PSU Power (Output)",
            "• PSU Efficiency (%)"
        ]

        # Two columns layout
        col_count = 2
        col_width = 3.2 * inch
        row_height = 0.25 * inch
        x_start = 1.2 * inch
        y_start = y
        for i, desc in enumerate(plot_descriptions):
            col = i % col_count
            row = i // col_count
            x = x_start + col * col_width
            y_row = y_start - row * row_height
            c.drawString(x, y_row, desc)
        y = y_start - ((len(plot_descriptions) + 1) // col_count) * row_height
        
        c.showPage()
    
    def add_plot_to_pdf(self, c, plot_path, title):
        """Add a plot image to the PDF"""
        if not os.path.exists(plot_path):
            logger.warning(f"Plot not found: {plot_path}")
            return
        
        # Add title
        c.setFont("Helvetica-Bold", 16)
        c.drawCentredString(self.width / 2, self.height - 0.5 * inch, title)
        
        # Calculate image dimensions to fit on page
        max_width = self.width - 1 * inch
        max_height = self.height - 1.75 * inch
        
        # Get original image dimensions
        img = Image.open(plot_path)
        img_width, img_height = img.size
        
        # Calculate scaling factor
        width_ratio = max_width / img_width
        height_ratio = max_height / img_height
        scale = min(width_ratio, height_ratio)
        
        # Calculate final dimensions
        final_width = img_width * scale
        final_height = img_height * scale
        
        # Center the image
        x = (self.width - final_width) / 2
        y = 0.75 * inch
        
        # Draw the image
        c.drawImage(str(plot_path), x, y, width=final_width, height=final_height)
        
        c.showPage()
    
    def create_pdf_report(self):
        """Create the PDF report"""
        logger.info(f"\n{'='*80}")
        logger.info("STEP 2: CREATING PDF REPORT")
        logger.info(f"{'='*80}")
        
        # Check for plot files
        plot_files = list(Path(self.plots_dir).glob("*.png"))
        if not plot_files:
            logger.error(f"ERROR: No PNG files found in {self.plots_dir}")
            return False
        
        # Verify all plot files are complete (have non-zero size)
        import time
        incomplete_plots = []
        for plot_file in plot_files:
            if plot_file.stat().st_size == 0:
                incomplete_plots.append(plot_file.name)
        
        if incomplete_plots:
            logger.warning(f"Found {len(incomplete_plots)} incomplete plot files, waiting for completion...")
            time.sleep(1)  # Wait for files to be fully written
        
        logger.info(f"\nFound {len(plot_files)} plots")
        logger.info(f"Creating PDF: {self.pdf_filename}")
        
        # Get data information
        data_info = self.get_data_info()
        
        # Create PDF canvas
        c = canvas.Canvas(self.pdf_filename, pagesize=self.page_size)
        
        # Create title page
        self.create_title_page(c, data_info)
        
        # Add plots in order
        plot_count = 0
        for plot_filename in self.plot_order:
            plot_path = os.path.join(self.plots_dir, plot_filename)
            if os.path.exists(plot_path):
                title = plot_filename.replace('_', ' ').replace('.png', '')
                self.add_plot_to_pdf(c, plot_path, title)
                plot_count += 1
                logger.info(f"  Added: {plot_filename}")
        
        # Add any remaining plots not in the order list
        for plot_file in sorted(plot_files):
            if plot_file.name not in self.plot_order:
                title = plot_file.stem.replace('_', ' ')
                self.add_plot_to_pdf(c, plot_file, title)
                plot_count += 1
                logger.info(f"  Added: {plot_file.name}")
        
        # Save the PDF
        c.save()
        
        logger.info(f"\n✓ PDF report created: {self.pdf_filename}")
        logger.info(f"  Pages: {plot_count + 1} (1 title page + {plot_count} plots)")
        
        # Show file size
        file_size = os.path.getsize(self.pdf_filename)
        size_mb = file_size / (1024 * 1024)
        logger.info(f"  Size: {size_mb:.2f} MB")
        
        return True
    
    def create_summary_report(self):
        """Create a text summary of violations"""
        logger.info(f"\n{'='*80}")
        logger.info("VIOLATION SUMMARY")
        logger.info(f"{'='*80}")
        
        all_violations = []
        
        for col in self.data_df.columns:
            if col in ['Elapsed (ms)', 'Timestamp']:
                continue
            
            violations = self.check_violations(col, self.data_df[col])
            if violations:
                all_violations.append(f"{col}: {', '.join(violations)}")
        
        if not all_violations:
            logger.info("\n✓ NO VIOLATIONS DETECTED")
        else:
            logger.warning(f"\n⚠ FOUND VIOLATIONS IN {len(all_violations)} SENSORS:")
            for violation in all_violations:
                logger.warning(f"  • {violation}")

    def generate_complete_report(self):
        """Generate plots and PDF report"""
        # Step 1: Create plots
        self.create_all_plots()
        
        # Step 2: Create PDF
        self.create_pdf_report()
        
        # Step 3: Show summary
        self.create_summary_report()
        
        logger.info(f"\n{'='*80}")
        logger.info("REPORT GENERATION COMPLETE")
        logger.info(f"{'='*80}")
        logger.info(f"\n📁 Output directory: {os.path.abspath(self.output_base_dir)}")
        logger.info(f"   ├── plots/")
        logger.info(f"   │   └── [PNG files]")
        logger.info(f"   └── redfish_report_{self.timestamp}.pdf")
        logger.info(f"\n✓ All files ready!")


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description='Generate complete Redfish monitoring report (plots + PDF)'
    )
    parser.add_argument('--data-file', required=True, help='Path to redfish_data CSV file')
    parser.add_argument('--thresholds-file', required=True, help='Path to redfish_thresholds CSV file')
    parser.add_argument('--system-info-file', required=True, help='Path to system_info.json file')
    parser.add_argument('--output-path', required=True, help='Path to directory where report will be created')
    parser.add_argument('--expected-serial', required=True, help='Expected system serial number (for validation)')
    
    args = parser.parse_args()
    
    try:
        # Create report generator and generate everything
        generator = PlotOverTime(
            data_file=args.data_file,
            thresholds_file=args.thresholds_file,
            system_info_file=args.system_info_file,
            output_path=args.output_path,
            expected_serial=args.expected_serial
        )
        
        generator.generate_complete_report()
    
    except ValueError as e:
        logger.error(f"\nERROR: {e}")
        sys.exit(1)
    except FileNotFoundError as e:
        logger.error(f"\nERROR: {e}")
        sys.exit(1)
    except Exception as e:
        logger.error(f"\nERROR: Unexpected error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
