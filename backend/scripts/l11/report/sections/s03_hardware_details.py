from reportlab.platypus import Table, Paragraph, Spacer, KeepTogether, PageBreak
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from typing import List, Any, Optional

from .utils import (
    wrap_long_text_in_table,
    calculate_max_column_width,
    distribute_remaining_width,
    create_standard_table_style,
    find_column_index,
    CELL_PADDING,
    BOLD_FONT
)

class HardwareDetailsSection:
    """Handles generation of hardware details sections in PDF reports."""
    
    # Constants
    PADDING_SPACES = "    "  # Spaces added for text padding
    
    def __init__(self, normal_font_size: int = 10, archive_font_size: int = 6, special_width_cols: Optional[List[int]] = None):
        self.normal_font_size = normal_font_size
        self.archive_font_size = archive_font_size
        self.special_width_cols = special_width_cols or [0, 2]
    
    def calculate_column_widths(self, num_cols: int, width: float, section_name: str, table_data: List[List[Any]], font_size: int) -> Optional[List[float]]:
        """Calculate column widths based on section type and text content.
        
        Args:
            num_cols: Number of columns
            width: Total available width
            section_name: Section name (determines calculation strategy)
            table_data: Table data for content-based width calculation
            font_size: Font size
            
        Returns:
            List of column widths or None
        """
        if num_cols == 0:
            return None
        
        is_hardware_section = "Hardware Version" in section_name or "Detailed Hardware" in section_name
        is_archive_section = 'archive' in section_name.lower() or 'detailed hardware' in section_name.lower()
        
        # Handle Hardware Version/Detailed Hardware tables
        if is_hardware_section and num_cols >= 2 and table_data:
            headers = table_data[0]
            item_name_col = find_column_index(headers, "Item Name")
            
            if item_name_col >= 0:
                # Calculate Item Name column width
                item_name_width = calculate_max_column_width(
                    table_data, item_name_col, font_size, BOLD_FONT, self.PADDING_SPACES
                )
                
                # For archive/detailed sections, also apply special column logic
                if is_archive_section:
                    min_widths = {item_name_col: item_name_width}
                    
                    # Calculate widths for other special columns
                    for col_idx in self.special_width_cols:
                        if col_idx < num_cols and col_idx != item_name_col:
                            col_width = calculate_max_column_width(
                                table_data, col_idx, font_size
                            )
                            min_widths[col_idx] = col_width
                    
                    return distribute_remaining_width(width, min_widths, num_cols)
                else:
                    # For non-archive, only Item Name has special width
                    return distribute_remaining_width(width, {item_name_col: item_name_width}, num_cols)
        
        # Handle archive/detailed sections without Item Name column
        if is_archive_section and num_cols >= 3:
            min_widths = {}
            for col_idx in self.special_width_cols:
                if col_idx < num_cols:
                    col_width = calculate_max_column_width(
                        table_data, col_idx, font_size
                    )
                    min_widths[col_idx] = col_width
            
            return distribute_remaining_width(width, min_widths, num_cols)
        
        # Default: equal width for all columns
        return [width / num_cols] * num_cols

    def create_table_style(self, font_size: int):
        """Create a standard table style with given font size."""
        return create_standard_table_style(font_size)

    def add_section_to_story(self, story: List, section_name: str, node_tables: List, width: float, section_style: ParagraphStyle, node_style: ParagraphStyle) -> None:
        """Add a section with its node tables to the story.
        
        Args:
            story: PDF story elements list
            section_name: Name of the section
            node_tables: List of (serial_number, data_rows) tuples
            width: Available width for tables
            section_style: Paragraph style for section title
            node_style: Paragraph style for node serial numbers
        """
        story.append(PageBreak())
        story.append(Paragraph(section_name, section_style))
        
        is_archive = 'archive' in section_name.lower()
        is_detailed_hardware = "Detailed Hardware" in section_name or "Hardware Version" in section_name
        font_size = self.archive_font_size if is_archive else self.normal_font_size
        
        for sn, data_rows in node_tables:
            if not data_rows:
                continue
            
            # Create table data from dictionary rows
            headers = list(data_rows[0].keys())
            table_data = [headers] + [[row.get(h, '') for h in headers] for row in data_rows]
            
            # Calculate column widths and wrap text
            col_widths = self.calculate_column_widths(len(headers), width, section_name, table_data, font_size)
            wrap_long_text_in_table(table_data, col_widths, section_name, font_size)
            
            # Add padding to Item Name column for detailed hardware tables
            if is_detailed_hardware:
                item_name_idx = find_column_index(headers, 'Item Name')
                if item_name_idx >= 0:
                    for row_idx in range(1, len(table_data)):  # Skip header row
                        table_data[row_idx][item_name_idx] = f"  {table_data[row_idx][item_name_idx]}  "
            
            # Create and style table
            table = Table(table_data, colWidths=col_widths, repeatRows=1)
            table.setStyle(self.create_table_style(font_size))
            
            # Add to story with serial number
            story.append(KeepTogether([
                Paragraph(f'SN: {sn}', node_style),
                Spacer(1, 0.1 * inch),
                table
            ]))