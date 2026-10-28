from reportlab.platypus import Table, Paragraph, Spacer, KeepTogether
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from typing import List, Dict, Any, Optional, Tuple
import re

from .utils import (
    split_at_last_pipe,
    wrap_long_text_in_table,
    create_standard_table_style,
    CELL_PADDING,
    DEFAULT_FONT,
    BOLD_FONT
)

class CombinedTablesSection:
    """Handles generation of combined tables sections in PDF reports."""
    
    def __init__(self, special_sections: List[str], section_title_map: Dict[str, str], normal_font_size: int = 10):
        self.special_sections = special_sections
        self.section_title_map = section_title_map
        self.normal_font_size = normal_font_size

    def _calculate_header_widths(self, headers: List[str], section_name: str) -> Tuple[List[float], List[str]]:
        """Calculate widths for headers based on section type.
        
        Args:
            headers: List of header strings
            section_name: Name of the section
            
        Returns:
            Tuple of (header_widths, display_headers)
        """
        if section_name == "Software Version of L10 Server":
            # Create display headers with line breaks
            display_headers = [re.sub(r'(#\d)\s+', r'\1\n', header) for header in headers]
            display_headers = [header.replace("GPU Driver", "GPU\nDriver").replace("OS", "  OS  ") for header in display_headers]
            # Calculate widths based on the longest line in multi-line headers
            header_widths = []
            for header in display_headers:
                lines = header.split('\n')
                max_line_width = max(pdfmetrics.stringWidth(line, BOLD_FONT, self.normal_font_size) for line in lines)
                header_widths.append(max_line_width)
            return header_widths, display_headers
        else:
            # Calculate column widths based on header lengths
            header_widths = [pdfmetrics.stringWidth(header, BOLD_FONT, self.normal_font_size) for header in headers]
            return header_widths, headers
    
    def add_to_story(self, story: List, combined_data: Dict[str, List], width: float, section_style: ParagraphStyle) -> None:
        """Add combined tables section to the story.
        
        Args:
            story: PDF story elements list
            combined_data: Dictionary mapping section names to combined data
            width: Available width for tables
            section_style: Paragraph style for section titles
        """
        if not any(combined_data.values()):
            return
        
        first_section = True
        for section_name in self.special_sections:
            if not combined_data[section_name]:
                continue
            
            if not first_section:
                story.append(Spacer(1, 0.5))
            first_section = False
            
            headers = list(combined_data[section_name][0].keys())
            
            # Calculate header widths and get display headers
            header_widths, display_headers = self._calculate_header_widths(headers, section_name)
            
            # Calculate column widths proportionally
            total_header_width = sum(header_widths)
            if total_header_width > 0:
                col_widths = [width * hw / total_header_width for hw in header_widths]
            else:
                col_widths = [width / len(headers)] * len(headers) if headers else None
            
            # Use original headers (keys) to extract data from rows
            table_data = [display_headers] + [[row.get(h, '') for h in headers] for row in combined_data[section_name]]
            
            # Wrap long text
            wrap_long_text_in_table(table_data, col_widths, section_name, self.normal_font_size)
            
            # Create and style table
            table = Table(table_data, colWidths=col_widths, repeatRows=1)
            table.setStyle(create_standard_table_style(self.normal_font_size))
            
            # Add to story
            story.append(KeepTogether([
                Paragraph(self.section_title_map.get(section_name, section_name), section_style),
                table
            ]))