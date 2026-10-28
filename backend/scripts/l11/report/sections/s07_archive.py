from reportlab.platypus import Table, Paragraph, KeepTogether, PageBreak
from reportlab.lib.styles import ParagraphStyle
from typing import List, Dict, Any, Optional

from .utils import (
    wrap_long_text_in_table,
    calculate_max_column_width,
    distribute_remaining_width,
    create_archive_table_style,
)

class ArchiveSection:
    """Handles generation of archive sections in PDF reports."""
    
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
        
        is_archive_section = 'archive' in section_name.lower() or 'detailed hardware' in section_name.lower()
        
        if is_archive_section and num_cols >= 3:
            min_widths = {}
            for col_idx in self.special_width_cols:
                if col_idx < num_cols:
                    col_width = calculate_max_column_width(table_data, col_idx, font_size)
                    min_widths[col_idx] = col_width
            
            return distribute_remaining_width(width, min_widths, num_cols)
        
        # Default: equal width for all columns
        return [width / num_cols] * num_cols

    def create_table_style(self, font_size: int):
        """Create a standard table style with given font size."""
        return create_archive_table_style(font_size)

    def add_to_story(self, story: List, all_sections: Dict[str, List], width: float, section_style: ParagraphStyle, node_style: ParagraphStyle) -> None:
        """Add archive tables to the story.
        
        Args:
            story: PDF story elements list
            all_sections: Dictionary mapping section names to node tables
            width: Available width for tables
            section_style: Paragraph style for section titles
            node_style: Paragraph style for node serial numbers
        """
        for section_name in sorted(all_sections.keys()):
            if 'archive' not in section_name.lower():
                continue
            
            story.append(PageBreak())
            story.append(Paragraph(section_name, section_style))
            
            for sn, data_rows in all_sections[section_name]:
                if not data_rows:
                    continue
                
                # Create table data from dictionary rows
                headers = list(data_rows[0].keys())
                table_data = [headers] + [[row.get(h, '') for h in headers] for row in data_rows]
                
                # Calculate column widths and wrap text
                col_widths = self.calculate_column_widths(len(headers), width, section_name, table_data, self.archive_font_size)
                wrap_long_text_in_table(table_data, col_widths, section_name, self.archive_font_size)
                
                # Create and style table
                table = Table(table_data, colWidths=col_widths, repeatRows=1)
                table.setStyle(self.create_table_style(self.archive_font_size))
                
                # Add to story with serial number
                story.append(KeepTogether([Paragraph(f'SN: {sn}', node_style), table]))