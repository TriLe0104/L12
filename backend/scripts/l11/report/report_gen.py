import os
import sys
import argparse
import inspect
import json
from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, PageBreak, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from typing import List, Dict, Optional

# When running as script, add project root to path for absolute imports
if not __package__:
    sys.path.insert(0, str(Path(__file__).parent))

# Always use absolute imports
from sections.s01_introduction import IntroductionSection
from sections.s02_combined_tables import CombinedTablesSection
from sections.s03_hardware_details import HardwareDetailsSection
from sections.s04_pcie_topology import PCIeTopologySection
from sections.s05_sensor_plots import SensorPlotsSection
from sections.s06_test_summary import TestSummarySection
from sections.s07_archive import ArchiveSection
from sections.utils import wrap_long_text_in_table, create_table_styles, TestUtils
from utils.header_footer import HeaderFooter
from utils.data_manager import DataManager
from utils.plot_manager import PlotManager
from utils.config_manager import ConfigManager
from utils.watermark import apply_watermark
from utils.html_builder import Html


class ReportGen:
    """Unified Report Generator that can create both L10 (single node) and L11 (rack-level) reports."""

    # Title font size constants
    MAIN_TITLE_SIZE = 16
    GROUP_TITLE_SIZE = 16
    SUBTITLE_SIZE = 14
    TEST_TITLE_SIZE = 16
    BODY_FONT_SIZE = 12
    
    # Constants from sanity_software_report
    MARGIN = 0.5 * inch
    TITLE_FONT_SIZE = 16
    NODE_FONT_SIZE = 12
    ARCHIVE_FONT_SIZE = 6
    NORMAL_FONT_SIZE = 10
    BOTTOM_PADDING = 2
    SIDE_PADDING = 2
    GRID_WIDTH = 0.5
    CHARS_PER_INCH_BASE = 120  # Base for chars per inch calculation
    SPECIAL_WIDTH_COLS = [0, 2]  # Columns with minimum width for archive/detailed hardware

    # Special sections to combine across nodes (for L11)
    SPECIAL_SECTIONS = [
        "Firmware Version of L10 Server",
        "Hardware Version of L10 Server", 
        "Software Version of L10 Server"
    ]

    # Title mapping for special sections (for L11)
    SECTION_TITLE_MAP = {
        "Firmware Version of L10 Server": "Rack Firmware Version Summary",
        "Hardware Version of L10 Server": "Rack Hardware Summary",
        "Software Version of L10 Server": "Rack Software Version Summary"
    }

    def __init__(
        self,
        path: str,
        report_level: str = "L11",  # "L10" or "L11"
        include_cpu_temperatures: Optional[bool] = None,
        include_gpu_temperatures: Optional[bool] = None,
        include_memory_dimm_temperatures: Optional[bool] = None,
        include_vrm_temperatures: Optional[bool] = None,
        include_storage_temperatures: Optional[bool] = None,
        include_network_card_temperatures: Optional[bool] = None,
        include_pcie_plx_temperatures: Optional[bool] = None,
        include_hgx_temperatures: Optional[bool] = None,
        include_system_temperatures: Optional[bool] = None,
        include_fan_speeds: Optional[bool] = None,
        include_motherboard_voltages: Optional[bool] = None,
        include_cpu_voltages: Optional[bool] = None,
        include_system_power: Optional[bool] = None,
        include_psu_power_input: Optional[bool] = None,
        include_psu_power_output: Optional[bool] = None,
        include_psu_efficiency: Optional[bool] = None,
        watermark: bool = False
    ) -> None:
        """Initialize unified report generator.
        
        Args:
            path: Path to the node (L10) or rack (L11) directory
            report_level: "L10" for single node report, "L11" for rack-level report
        """
        self.path = os.path.abspath(path)
        self.watermark = watermark
        self.report_level = report_level

        # Initialize config manager
        self.config_manager = ConfigManager(
            include_cpu_temperatures=include_cpu_temperatures,
            include_gpu_temperatures=include_gpu_temperatures,
            include_memory_dimm_temperatures=include_memory_dimm_temperatures,
            include_vrm_temperatures=include_vrm_temperatures,
            include_storage_temperatures=include_storage_temperatures,
            include_network_card_temperatures=include_network_card_temperatures,
            include_pcie_plx_temperatures=include_pcie_plx_temperatures,
            include_hgx_temperatures=include_hgx_temperatures,
            include_system_temperatures=include_system_temperatures,
            include_fan_speeds=include_fan_speeds,
            include_motherboard_voltages=include_motherboard_voltages,
            include_cpu_voltages=include_cpu_voltages,
            include_system_power=include_system_power,
            include_psu_power_input=include_psu_power_input,
            include_psu_power_output=include_psu_power_output,
            include_psu_efficiency=include_psu_efficiency
        )

        # Initialize test utils
        self.test_utils = TestUtils()

        # Initialize section modules
        self.hardware_section = HardwareDetailsSection(
            self.NORMAL_FONT_SIZE, self.ARCHIVE_FONT_SIZE, self.SPECIAL_WIDTH_COLS
        )
        self.sensor_section = SensorPlotsSection()
        self.archive_section = ArchiveSection(
            self.NORMAL_FONT_SIZE, self.ARCHIVE_FONT_SIZE, self.SPECIAL_WIDTH_COLS
        )
        self.pcie_topology_section = PCIeTopologySection()

        # Initialize data structures
        self.node_data: Dict = {}
        self.all_sections: Dict = {}
        self.combined_data: Dict = {}
        self.all_sns: List[str] = []
        self.existing_sns: List[str] = []
        
        # L10-specific attributes
        if report_level == "L10":
            self.node_path: str = self.path
            self.node_sn: str = os.path.basename(self.node_path)
            self.rack_path: str = os.path.dirname(self.node_path)  # Parent directory is the rack
        else:  # L11
            self.rack_path = self.path
            self.node_path = ""
            self.node_sn = ""
        
        # Initialize combined section for L11
        if report_level == "L11":
            self.combined_section = CombinedTablesSection(
                self.SPECIAL_SECTIONS, 
                self.SECTION_TITLE_MAP, 
                self.NORMAL_FONT_SIZE
            )

    def _get_project_display_name(self, project_config_path: str) -> Optional[str]:
        """Read project display name from config file."""
        try:
            if os.path.exists(project_config_path):
                with open(project_config_path, 'r') as f:
                    project_config = json.load(f)
                    return project_config.get('proj_display_name')
        except Exception:
            pass
        return None

    def _get_project_display_name_for_path(self) -> Optional[str]:
        """Get project display name from config."""
        if self.report_level == "L10":
            project_config_path = os.path.join(os.path.dirname(os.path.dirname(self.rack_path)), 'project_config.json')
        else:  # L11
            project_config_path = os.path.join(os.path.dirname(os.path.dirname(self.rack_path)), 'project_config.json')
        return self._get_project_display_name(project_config_path)

    def _generate_pdf_filename(self, project_display_name: Optional[str]) -> str:
        """Generate the PDF filename based on report level."""
        if self.report_level == "L10":
            if project_display_name:
                base_name = project_display_name.replace(' ', '_')
                return f'L10_{base_name}_{self.node_sn}_Report.pdf'
            return f'L10_{self.node_sn}_Report.pdf'
        else:  # L11
            if project_display_name:
                base_name = project_display_name.replace(' ', '_')
                return f'L11_{base_name}_Report.pdf'
            return 'L11_Report.pdf'

    def on_page(self, canvas, doc):
        """Callback for page generation."""
        self.header_footer.draw_header_footer(canvas)
    def _initialize_managers(self) -> None:
        """Initialize data manager, plot manager, and other managers."""
        # Initialize test section
        self.test_section = TestSummarySection(
            self.rack_path, 
            is_l10_report=(self.report_level == "L10")
        )
        
        # Initialize header/footer
        self.header_footer = HeaderFooter(self.rack_path)
        
        # Get project display name
        project_display_name = self._get_project_display_name_for_path()
        self.introduction_section = IntroductionSection(
            project_display_name or "Project", 
            report_level=self.report_level
        )

        # Initialize data manager
        self.data_manager = DataManager(self.rack_path)
        
        # Initialize plot manager based on report level
        if self.report_level == "L10":
            # For L10, only plot data for this specific node
            sensor_min, sensor_max = self.data_manager.get_sensor_min_max()
            # Filter to only this node's data
            node_only_min = {}
            node_only_max = {}
            node_idx = None
            if self.node_sn in self.data_manager.rack_folders_ordered:
                node_idx = self.data_manager.rack_folders_ordered.index(self.node_sn)
                for header in sensor_min.keys():
                    if node_idx < len(sensor_min[header]):
                        node_only_min[header] = [sensor_min[header][node_idx]]
                        node_only_max[header] = [sensor_max[header][node_idx]]
            else:
                # Node not found, use empty data
                for header in sensor_min.keys():
                    node_only_min[header] = []
                    node_only_max[header] = []
            
            self.plot_manager = PlotManager(
                self.node_path,
                self.data_manager.headers,
                self.data_manager.group_map,
                [self.node_sn],
                node_only_min,
                node_only_max,
                show_serial_numbers=False  # L10 doesn't show serial numbers on plots
            )
        else:  # L11
            self.plot_manager = PlotManager(
                self.rack_path,
                self.data_manager.headers,
                self.data_manager.group_map,
                self.data_manager.rack_folders_ordered,
                *self.data_manager.get_sensor_min_max(),
                show_serial_numbers=True  # L11 shows serial numbers
            )

    def _collect_report_data(self) -> None:
        """Collect all data needed for the report."""
        assert self.data_manager is not None, "data_manager must be initialized"
        
        # Collect node data - get all data first
        all_rack_sns, existing_rack_sns = self.data_manager.get_node_info()
        all_node_data, combined_data, all_rack_sections = self.data_manager.collect_node_data(all_rack_sns, existing_rack_sns)
        
        if self.report_level == "L10":
            # Filter to only this node's data
            self.node_data = {self.node_sn: all_node_data.get(self.node_sn, {})}
            self.all_sections = {}
            
            # all_rack_sections is a defaultdict(list) where each value is [(sn, data_rows), ...]
            # Convert to dict[section_name][node_sn] = data_rows format
            for section_name, sn_data_list in all_rack_sections.items():
                for sn, data_rows in sn_data_list:
                    if sn == self.node_sn:
                        if section_name not in self.all_sections:
                            self.all_sections[section_name] = []
                        self.all_sections[section_name].append((sn, data_rows))
            
            # For L10, also include SPECIAL_SECTIONS from combined_data (filtered to this node)
            for section_name in self.SPECIAL_SECTIONS:
                if section_name in combined_data and combined_data[section_name]:
                    node_data = [row for row in combined_data[section_name] if row.get('SN') == self.node_sn or row.get('Serial Number') == self.node_sn]
                    if node_data and section_name not in self.all_sections:
                        self.all_sections[section_name] = [(self.node_sn, node_data)]
            
            self.existing_sns = [self.node_sn] if self.node_sn in existing_rack_sns else []
        else:  # L11
            self.all_sns = all_rack_sns
            self.existing_sns = existing_rack_sns
            self.node_data = all_node_data
            self.combined_data = combined_data
            # Convert defaultdict(list) to list of tuples format
            self.all_sections = {}
            for section_name, sn_data_list in all_rack_sections.items():
                self.all_sections[section_name] = sn_data_list

    def _has_test_data(self) -> bool:
        """Check if test summary data is available."""
        summary_dir = os.path.join(self.rack_path, "summary_report")
        if not os.path.exists(summary_dir):
            return False
        files = [f for f in os.listdir(summary_dir) if f.endswith(".csv") and "test_summary" in f]
        return len(files) > 0

    def _filter_test_data_for_node(self, tests: List[Dict]) -> List[Dict]:
        """Filter test data to only include rows for this specific node and remove SN column (L10 only)."""
        filtered_tests = []
        for test in tests:
            if not test["data"]:
                filtered_tests.append(test)
                continue
            
            header = test["header"]
            # Find Node or SN column in the ORIGINAL header
            node_col_idx = None
            sn_col_idx = None
            for idx, col in enumerate(header):
                if col in ['Node', 'Server SN', 'SN', 'Serial Number']:
                    node_col_idx = idx
                    sn_col_idx = idx
                    break
            
            # Filter data rows by matching SN (using ORIGINAL indices)
            filtered_data = []
            for row in test["data"]:
                if node_col_idx is not None and node_col_idx < len(row):
                    if row[node_col_idx] == self.node_sn:
                        filtered_data.append(row)
                else:
                    # No SN column found, include all rows
                    filtered_data.append(row)
            
            # If no data matched, skip this test entirely
            if not filtered_data:
                continue
            
            # Now remove SN column from BOTH header and data
            # Build the filtered header AND determine which ORIGINAL column indices to keep
            filtered_header = []
            keep_col_indices = []
            
            for idx, col in enumerate(header):
                # Skip SN-related columns
                if col in ['Node', 'Server SN', 'SN', 'Serial Number']:
                    continue
                filtered_header.append(col)
                keep_col_indices.append(idx)
            
            # Now filter each data row using keep_col_indices from the ORIGINAL row
            filtered_data_no_sn = []
            for original_row in filtered_data:
                new_row = []
                for idx in keep_col_indices:
                    if idx < len(original_row):
                        new_row.append(original_row[idx])
                    else:
                        new_row.append('')
                filtered_data_no_sn.append(new_row)
            
            if filtered_data_no_sn and filtered_header:
                filtered_tests.append({
                    "name": test["name"],
                    "header": filtered_header,
                    "data": filtered_data_no_sn
                })
        
        return filtered_tests

    def _add_l10_section_to_story(self, story: List, section_name: str, node_tables: List, width: float, section_style) -> None:
        """Add a section for L10 - no SN columns, no subtitles, use KeepTogether."""
        from reportlab.platypus import KeepTogether, Table, Spacer
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib import colors
        
        # Clean up section name for L10
        display_name = section_name.replace(' Per Node', '').replace(' of L10 Server', '')
        
        # Rename "Hardware Version" to "Hardware Summary" for the first section
        if display_name == "Hardware Version":
            display_name = "Hardware Summary"
        
        story.append(Paragraph(display_name, section_style))
        story.append(Spacer(1, 0.1*inch))
        
        is_archive = 'archive' in section_name.lower()
        is_software_version = "Software Version" in section_name
        
        for sn, data_rows in node_tables:
            if not data_rows:
                continue
            
            # Filter out SN columns
            headers = list(data_rows[0].keys())
            sn_column_names = ['SN', 'Serial Number', 'Node SN', 'Server SN']
            filtered_headers = [h for h in headers if h not in sn_column_names]
            
            if not filtered_headers:
                continue
            
            num_cols = len(filtered_headers)
            font_size = self.ARCHIVE_FONT_SIZE if is_archive else self.NORMAL_FONT_SIZE
            
            # For Detailed Hardware tables, add padding to Item Name column
            is_detailed_hardware = "Detailed Hardware" in section_name or "Hardware Version" in section_name
            
            # For Software Version, convert headers to Paragraphs with line breaks
            if is_software_version:
                styles = getSampleStyleSheet()
                header_style = ParagraphStyle(
                    'TableHeader',
                    parent=styles['Normal'],
                    fontSize=font_size,
                    textColor=colors.black,
                    alignment=1
                )
                table_data = [[Paragraph(Html.replace_spaces_with_breaks(h), header_style) for h in filtered_headers]]
                table_data += [[row.get(h, '') for h in filtered_headers] for row in data_rows]
            else:
                table_data = [filtered_headers] + [[row.get(h, '') for h in filtered_headers] for row in data_rows]
            
            col_widths = self.hardware_section.calculate_column_widths(num_cols, width, section_name, table_data, font_size)
            wrap_long_text_in_table(table_data, col_widths, section_name, font_size)
            
            # After wrapping, add padding to Item Name values for detailed hardware tables
            # Skip this for software version tables since they use Paragraph objects
            if is_detailed_hardware and 'Item Name' in filtered_headers and not is_software_version:
                item_name_idx = filtered_headers.index('Item Name')
                for row_idx in range(1, len(table_data)):
                    # Only add padding to string values
                    cell_value = table_data[row_idx][item_name_idx]
                    if isinstance(cell_value, str):
                        table_data[row_idx][item_name_idx] = '    ' + cell_value  # type: ignore
            
            table = Table(table_data, colWidths=col_widths, repeatRows=1)
            
            # Use special table style for Software Version (don't override Paragraph font)
            if is_software_version:
                table.setStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
                    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
                    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                    ('GRID', (0, 0), (-1, -1), self.GRID_WIDTH, colors.black),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), self.BOTTOM_PADDING),
                    ('TOPPADDING', (0, 0), (-1, -1), self.BOTTOM_PADDING),
                    ('LEFTPADDING', (0, 0), (-1, -1), self.SIDE_PADDING),
                    ('RIGHTPADDING', (0, 0), (-1, -1), self.SIDE_PADDING),
                ])
            else:
                table.setStyle(self.hardware_section.create_table_style(font_size))
            
            story.append(KeepTogether([table]))
        
        story.append(Spacer(1, 0.2*inch))

    def _add_l10_archive_to_story(self, story: List, section_name: str, node_tables: List, width: float, section_style, is_first: bool = False) -> None:
        """Add archive section for L10 - no SN columns, no subtitles, use KeepTogether."""
        from reportlab.platypus import KeepTogether, Table, Spacer, Paragraph
        
        # Clean up section name for L10
        display_name = section_name.replace(' Per Node', '').replace(' of L10 Server', '')
        
        for sn, data_rows in node_tables:
            if not data_rows:
                continue
            
            # Filter out SN columns
            headers = list(data_rows[0].keys())
            sn_column_names = ['SN', 'Serial Number', 'Node SN', 'Server SN']
            filtered_headers = [h for h in headers if h not in sn_column_names]
            
            if not filtered_headers:
                continue
            
            table_data = [filtered_headers] + [[row.get(h, '') for h in filtered_headers] for row in data_rows]
            
            num_cols = len(filtered_headers)
            font_size = self.ARCHIVE_FONT_SIZE
            
            col_widths = self.archive_section.calculate_column_widths(num_cols, width, section_name, table_data, font_size)
            wrap_long_text_in_table(table_data, col_widths, section_name, font_size)
            
            table = Table(table_data, colWidths=col_widths, repeatRows=1)
            table.setStyle(self.archive_section.create_table_style(font_size))
            
            story.append(KeepTogether([table]))
        
        story.append(Spacer(1, 0.2*inch))

    def _build_story(self, story: List, width: float, title_style, section_style, node_style, menu_item_style, styles) -> None:
        """Build the PDF story content based on report level."""
        assert self.introduction_section is not None, "introduction_section must be initialized"
        assert self.data_manager is not None, "data_manager must be initialized"
        assert self.plot_manager is not None, "plot_manager must be initialized"
        assert self.test_section is not None, "test_section must be initialized"
        
        # Add introduction section
        self.introduction_section.add_to_story(story)
        
        if self.report_level == "L10":
            self._build_l10_story(story, width, title_style, section_style, node_style, menu_item_style, styles)
        else:  # L11
            self._build_l11_story(story, width, title_style, section_style, node_style, menu_item_style, styles)

    def _build_l10_story(self, story: List, width: float, title_style, section_style, node_style, menu_item_style, styles) -> None:
        """Build the PDF story for L10 report."""
        # Title page
        story.append(Paragraph(f"L10 Report - Node {self.node_sn}", title_style))
        story.append(Spacer(1, 0.5*inch))
        story.append(Paragraph(Html.link('#hardware', '• Hardware Details'), menu_item_style))
        story.append(Paragraph(Html.link('#pcie_topology', '• PCIe Topology Diagram'), menu_item_style))
        if self.data_manager.headers:
            story.append(Paragraph(Html.link('#sensor', '• Sensor Min/Max Reading Report'), menu_item_style))
        if self._has_test_data():
            story.append(Paragraph(Html.link('#test', '• Test Summary'), menu_item_style))
        story.append(Paragraph(Html.link('#archive', "• Archive: all parts' Part Number (PN), Serial Number (SN) and Firmware (FW)"), menu_item_style))
        story.append(PageBreak())
        
        # Add hardware details (excluding archive)
        story.append(Paragraph(Html.anchor('hardware'), styles['Normal']))
        
        # Define the order: version tables first, then detailed hardware
        priority_sections = ["Firmware Version", "Hardware Version", "Software Version"]
        detailed_section = "Detailed Hardware Version"
        
        # Add priority sections first (Firmware, Hardware, Software Version)
        for section_name in sorted(self.all_sections.keys()):
            for priority in priority_sections:
                if priority in section_name and 'archive' not in section_name.lower() and detailed_section not in section_name:
                    node_tables = self.all_sections[section_name]
                    self._add_l10_section_to_story(story, section_name, node_tables, width, section_style)
                    break
        
        # Add detailed hardware version section
        for section_name in sorted(self.all_sections.keys()):
            if detailed_section in section_name and 'archive' not in section_name.lower():
                node_tables = self.all_sections[section_name]
                self._add_l10_section_to_story(story, section_name, node_tables, width, section_style)
        
        # Add any remaining sections (not priority, not detailed)
        for section_name in sorted(self.all_sections.keys()):
            if ('archive' not in section_name.lower() and 
                detailed_section not in section_name and
                not any(priority in section_name for priority in priority_sections)):
                node_tables = self.all_sections[section_name]
                self._add_l10_section_to_story(story, section_name, node_tables, width, section_style)
        
        # Add PCIe topology diagram
        self.pcie_topology_section.add_to_story(story, self.rack_path, self.existing_sns, section_style, node_style)
        
        # Add sensor plots (only if sensor data exists)
        if self.data_manager.headers:
            story.append(Paragraph('<a name="sensor"/>', styles['Normal']))
            included_groups = self.config_manager.get_included_groups()
            self.sensor_section.add_to_story(story, included_groups, self.data_manager.group_map, self.plot_manager.plot_dir, section_style, menu_item_style, title_style)
        
        # Add test summary
        if self._has_test_data():
            self.test_section.add_section(story, width, styles, title_style, section_style, menu_item_style, node_sn=self.node_sn)
        
        # Add archive tables
        
        is_first_archive = True
        for section_name in sorted(self.all_sections.keys()):
            if 'archive' in section_name.lower():
                node_tables = self.all_sections[section_name]
                if is_first_archive:
                    story.append(Paragraph(Html.anchor('archive'), styles['Normal']))
                    story.append(Paragraph("Archive", title_style))
                    story.append(Spacer(1, 0.2*inch))
                    is_first_archive = False
                self._add_l10_archive_to_story(story, section_name, node_tables, width, section_style, is_first_archive)

    def _build_l11_story(self, story: List, width: float, title_style, section_style, node_style, menu_item_style, styles) -> None:
        """Build the PDF story for L11 report."""
        # Title page
        story.append(Paragraph("L11 Report Table of Contents", title_style))
        story.append(Spacer(1, 0.5*inch))
        story.append(Paragraph(Html.link('#combined', '• Rack Summary'), menu_item_style))
        story.append(Paragraph(Html.link('#hardware', '• Hardware Details per Node'), menu_item_style))
        story.append(Paragraph(Html.link('#pcie_topology', '• PCIe Topology Diagram'), menu_item_style))
        if self.data_manager.headers:
            story.append(Paragraph(Html.link('#sensor', '• Sensor Min/Max Reading Report'), menu_item_style))
        if self._has_test_data():
            story.append(Paragraph(Html.link('#test', '• Test Summary'), menu_item_style))
        story.append(Paragraph(Html.link('#archive', "• Archive: all parts' Part Number (PN), Serial Number (SN) and Firmware (FW)"), menu_item_style))
        story.append(PageBreak())
        
        # Add combined tables
        story.append(Paragraph(Html.anchor('combined'), styles['Normal']))
        self.combined_section.add_to_story(story, self.combined_data, width, section_style)
        
        # Add detailed hardware per node (excluding archive)
        story.append(Paragraph(Html.anchor('hardware'), styles['Normal']))
        for section_name in sorted(self.all_sections.keys()):
            if section_name not in self.SPECIAL_SECTIONS and 'archive' not in section_name.lower():
                self.hardware_section.add_section_to_story(story, section_name, self.all_sections[section_name], width, section_style, node_style)
        
        # Add PCIe topology diagrams
        self.pcie_topology_section.add_to_story(story, self.rack_path, self.existing_sns, section_style, node_style)
        
        # Add sensor plots (only if sensor data exists)
        if self.data_manager.headers:
            story.append(Paragraph(Html.anchor('sensor'), styles['Normal']))
            included_groups = self.config_manager.get_included_groups()
            self.sensor_section.add_to_story(story, included_groups, self.data_manager.group_map, self.plot_manager.plot_dir, section_style, menu_item_style, title_style)
        
        # Add test summary
        if self._has_test_data():
            self.test_section.add_section(story, width, styles, title_style, section_style, menu_item_style)
        
        # Add archive tables
        story.append(Paragraph(Html.anchor('archive'), styles['Normal']))
        self.archive_section.add_to_story(story, self.all_sections, width, section_style, node_style)

    def create_pdf_report(self, pdf_path: Optional[str] = None) -> None:
        """Create the PDF report. This is the main entry point."""
        # Initialize managers (data, plot, etc.)
        self._initialize_managers()
        
        # Generate filename if not provided
        if pdf_path is None:
            project_display_name = self._get_project_display_name_for_path()
            filename = self._generate_pdf_filename(project_display_name)
            
            # Prepend SAMPLE_ if watermark is enabled
            if self.watermark:
                filename = f'SAMPLE_{filename}'
            
            pdf_path = os.path.join(self.rack_path, filename)
        
        # Generate sensor plots only if sensor data is available
        if self.data_manager.headers:
            self.plot_manager.plot_all(self.config_manager.get_included_groups())
        else:
            print("Skipping sensor plot generation: No sensor data available.", file=sys.stderr)
        
        # Collect report data
        self._collect_report_data()
        
        # Create PDF document
        doc = SimpleDocTemplate(
            pdf_path, 
            pagesize=letter, 
            leftMargin=self.MARGIN, 
            rightMargin=self.MARGIN, 
            topMargin=self.MARGIN, 
            bottomMargin=self.MARGIN
        )
        
        story = []
        title_style, section_style, node_style, menu_item_style = create_table_styles()
        styles = getSampleStyleSheet()
        width = letter[0] - 2*self.MARGIN
        
        # Build the story (report content)
        self._build_story(story, width, title_style, section_style, node_style, menu_item_style, styles)
        
        # Build PDF
        doc.build(story, onFirstPage=self.on_page, onLaterPages=self.on_page)
        
        # Apply watermark if requested
        if self.watermark:
            print('Applying watermark...')
            try:
                apply_watermark(pdf_path)
            except ImportError:
                print("WARNING: PyPDF2 not installed. Watermark not applied. Install with: pip install PyPDF2")
            except Exception as e:
                print(f"WARNING: Failed to apply watermark: {e}")
        
        print(f'{self.report_level} PDF report generated: {pdf_path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Generate PDF report for rack or node')
    parser.add_argument('--path', required=True, help='Path to rack folder (default) or node folder (with -l10)')
    parser.add_argument('-l10', '--l10', action='store_true', 
                       help='Generate L10 report for single node (default is L11 for rack)')
    parser.add_argument('--watermark', action='store_true',
                       help='Add "SAMPLE - NOT FINAL REPORT" watermark to the PDF')
    
    # Sensor groups with their display names and default values from ConfigManager
    sig = inspect.signature(ConfigManager.__init__)
    sensor_groups = {
        'cpu_temperatures': ('CPU Temperatures', sig.parameters['include_cpu_temperatures'].default),
        'gpu_temperatures': ('GPU Temperatures', sig.parameters['include_gpu_temperatures'].default),
        'memory_dimm_temperatures': ('Memory (DIMM) Temperatures', sig.parameters['include_memory_dimm_temperatures'].default),
        'vrm_temperatures': ('VRM Temperatures', sig.parameters['include_vrm_temperatures'].default),
        'storage_temperatures': ('Storage Temperatures', sig.parameters['include_storage_temperatures'].default),
        'network_card_temperatures': ('Network Card Temperatures', sig.parameters['include_network_card_temperatures'].default),
        'pcie_plx_temperatures': ('PCIe/PLX Temperatures', sig.parameters['include_pcie_plx_temperatures'].default),
        'hgx_temperatures': ('HGX Temperatures', sig.parameters['include_hgx_temperatures'].default),
        'system_temperatures': ('System Temperatures', sig.parameters['include_system_temperatures'].default),
        'fan_speeds': ('Fan Speeds', sig.parameters['include_fan_speeds'].default),
        'motherboard_voltages': ('Motherboard Voltages', sig.parameters['include_motherboard_voltages'].default),
        'cpu_voltages': ('CPU Voltages', sig.parameters['include_cpu_voltages'].default),
        'system_power': ('System Power', sig.parameters['include_system_power'].default),
        'psu_power_input': ('PSU Power (Input)', sig.parameters['include_psu_power_input'].default),
        'psu_power_output': ('PSU Power (Output)', sig.parameters['include_psu_power_output'].default),
        'psu_efficiency': ('PSU Efficiency', sig.parameters['include_psu_efficiency'].default)
    }
    
    # Add arguments for each sensor group with true/false values
    for group_key, (display_name, default_val) in sensor_groups.items():
        arg_name = group_key.replace('_', '-')
        parser.add_argument(f'--{arg_name}', 
                          dest=f'include_{group_key}', 
                          type=lambda x: str(x).lower() == 'true',
                          default=default_val,
                          metavar='true/false',
                          help=f'Include {display_name} (default: {default_val})')
    
    args = parser.parse_args()
    
    # Determine report level based on -l10 flag
    report_level = "L10" if args.l10 else "L11"
    
    # Create the report with all sensor group arguments
    sensor_kwargs = {f'include_{key}': getattr(args, f'include_{key}') for key in sensor_groups.keys()}
    sensor_kwargs['watermark'] = args.watermark
    sensor_kwargs['report_level'] = report_level
    
    report = ReportGen(args.path, **sensor_kwargs)
    report.create_pdf_report()
