"""Table styling and column width calculation utilities for PDF reports."""

from reportlab.platypus import TableStyle
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from typing import List, Any, Dict, Optional, Tuple


# Constants
CELL_PADDING = 10  # Points of horizontal padding per cell
DEFAULT_FONT = 'Helvetica'
BOLD_FONT = 'Helvetica-Bold'
TITLE_FONT_SIZE = 16
SECTION_FONT_SIZE = 14
NODE_FONT_SIZE = 12
NORMAL_FONT_SIZE = 10
CHARS_PER_INCH_BASE = 120  # Base for chars per inch calculation
SPECIAL_WIDTH_COLS = [0, 2]  # Columns with minimum width for archive/detailed hardware


def calculate_max_column_width(table_data: List[List[Any]], col_idx: int, font_size: int, font_name: str = DEFAULT_FONT, add_padding: str = "") -> float:
    """Calculate maximum width needed for a column based on content.
    
    Args:
        table_data: Table data
        col_idx: Column index
        font_size: Font size
        font_name: Font name for measurement (default: Helvetica)
        add_padding: Optional padding string to add to text
        
    Returns:
        Maximum width in points including cell padding
    """
    max_width = 0
    for row in table_data:
        if col_idx < len(row):
            text = str(row[col_idx]) + add_padding
            text_width = pdfmetrics.stringWidth(text, font_name, font_size)
            max_width = max(max_width, text_width)
    return max_width + CELL_PADDING


def distribute_remaining_width(total_width: float, reserved_widths: Dict[int, float], num_cols: int) -> List[float]:
    """Distribute remaining width among non-reserved columns.
    
    Args:
        total_width: Total available width
        reserved_widths: Dict mapping column indices to their fixed widths
        num_cols: Total number of columns
        
    Returns:
        List of column widths
    """
    special_width = sum(reserved_widths.values())
    remaining_width = total_width - special_width
    other_cols = num_cols - len(reserved_widths)
    other_width = remaining_width / other_cols if other_cols > 0 else remaining_width
    
    return [reserved_widths.get(i, other_width) for i in range(num_cols)]


def create_standard_table_style(font_size: int, bold_font: str = BOLD_FONT, include_padding: bool = True) -> TableStyle:
    """Create a standard table style with given font size.
    
    Args:
        font_size: Font size for the table
        bold_font: Font name for bold text (default: Helvetica-Bold)
        include_padding: Whether to include standard padding (default: True)
        
    Returns:
        TableStyle object
    """
    style_commands = [
        ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.black),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('FONTNAME', (0, 0), (-1, 0), bold_font),
        ('FONTSIZE', (0, 0), (-1, -1), font_size),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
    ]
    
    if include_padding:
        style_commands.extend([
            ('BOTTOMPADDING', (0, 0), (-1, 0), 2),
            ('LEFTPADDING', (0, 0), (-1, -1), 2),
            ('RIGHTPADDING', (0, 0), (-1, -1), 2),
        ])
    
    return TableStyle(style_commands)


def create_archive_table_style(font_size: int, bold_font: str = BOLD_FONT) -> TableStyle:
    """Create a table style optimized for archive sections with minimal padding.
    
    Args:
        font_size: Font size for the table
        bold_font: Font name for bold text (default: Helvetica-Bold)
        
    Returns:
        TableStyle object
    """
    return TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.black),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('FONTNAME', (0, 0), (-1, 0), bold_font),
        ('FONTSIZE', (0, 0), (-1, -1), font_size),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('LEFTPADDING', (0, 0), (-1, -1), 2),
        ('RIGHTPADDING', (0, 0), (-1, -1), 2),
        ('LEADING', (0, 0), (-1, -1), font_size + 2),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
    ])


def split_at_last_pipe(text: str, max_chars: int) -> List[str]:
    """Recursively split text at the last | within max_chars.
    
    Args:
        text: Text to split
        max_chars: Maximum characters per segment
        
    Returns:
        List of text segments split at pipe characters
    """
    if len(text) <= max_chars or "|" not in text:
        return [text]
    last_pipe = text.rfind("|", 0, max_chars)
    if last_pipe == -1:
        return [text]
    part1 = text[:last_pipe + 1]
    part2 = text[last_pipe + 1:]
    return [part1] + split_at_last_pipe(part2, max_chars)


def wrap_long_text(data: List[List[Any]], col_widths: Optional[List[float]] = None, 
                   section_name: str = "", font_size: int = NORMAL_FONT_SIZE) -> None:
    """Wrap long text in table cells based on column widths or split at | for archive sections.
    
    Args:
        data: Table data (list of rows)
        col_widths: Column widths in points
        section_name: Section name (determines wrapping strategy)
        font_size: Font size for character calculations
    """
    if not col_widths:
        return
        
    # Calculate characters per inch based on font size (approximation for Helvetica)
    chars_per_inch = CHARS_PER_INCH_BASE / font_size  # At 10pt: 12 chars/inch, at 8pt: 15 chars/inch

    if 'archive' in section_name.lower():
        for row_idx, row in enumerate(data):
            if row_idx == 0:  # Skip headers
                continue
            for i, cell in enumerate(row):
                if i < len(col_widths):
                    cell_str = str(cell)
                    if "|" in cell_str:
                        col_width_points = col_widths[i]
                        col_width_inches = col_width_points / inch
                        max_chars = int(col_width_inches * chars_per_inch)
                        if len(cell_str) > max_chars:
                            parts = split_at_last_pipe(cell_str, max_chars)
                            row[i] = '\n'.join(parts)
    else:
        for row_idx, row in enumerate(data):
            if row_idx == 0:  # Skip headers
                continue
            for i, cell in enumerate(row):
                if i < len(col_widths):
                    col_width_points = col_widths[i]
                    col_width_inches = col_width_points / inch
                    max_chars = int(col_width_inches * chars_per_inch)
                    cell_str = str(cell)
                    if len(cell_str) > max_chars:
                        row[i] = '\n'.join([cell_str[j:j+max_chars] for j in range(0, len(cell_str), max_chars)])


def calculate_column_widths(num_cols: int, width: float, section_name: str, 
                           table_data: List[List[Any]], font_size: int) -> Optional[List[float]]:
    """Calculate column widths based on section type and text content.
    
    Args:
        num_cols: Number of columns
        width: Total available width
        section_name: Section name (determines calculation strategy)
        table_data: Table data for content-based width calculation
        font_size: Font size for measurements
        
    Returns:
        List of column widths or None
    """
    if num_cols == 0:
        return None
        
    if ('archive' in section_name.lower() or 'detailed hardware' in section_name.lower()) and num_cols >= 3:
        # Calculate minimum widths based on longest text in special columns
        min_widths = {}
        for col_idx in SPECIAL_WIDTH_COLS:
            if col_idx < num_cols:
                max_width = 0
                for row in table_data:
                    if col_idx < len(row):
                        text = str(row[col_idx])
                        text_width = pdfmetrics.stringWidth(text, DEFAULT_FONT, font_size)
                        max_width = max(max_width, text_width)
                # Add some padding
                min_widths[col_idx] = max_width + 10  # 10 points padding

        # For special columns, use calculated min width
        col_widths = []
        for i in range(num_cols):
            if i in SPECIAL_WIDTH_COLS:
                col_widths.append(min_widths.get(i, 0))
            else:
                # Will be set after calculating total special width
                col_widths.append(0)

        # Calculate remaining width
        special_width = sum(col_widths[i] for i in SPECIAL_WIDTH_COLS if i < num_cols)
        remaining_width = width - special_width
        other_cols = num_cols - len(SPECIAL_WIDTH_COLS)
        other_width = remaining_width / other_cols if other_cols > 0 else remaining_width

        for i in range(num_cols):
            if i not in SPECIAL_WIDTH_COLS:
                col_widths[i] = other_width

        return col_widths
    else:
        return [width / num_cols] * num_cols


def create_table_styles() -> Tuple[ParagraphStyle, ParagraphStyle, ParagraphStyle, ParagraphStyle]:
    """Create paragraph styles for titles, sections, nodes, and menu items.
    
    Returns:
        Tuple of (title_style, section_style, node_style, menu_item_style)
    """
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        'NodeTitle',
        parent=styles['Heading1'],
        fontSize=TITLE_FONT_SIZE,
        spaceAfter=0.5 * inch,
        alignment=1  # CENTER
    )
    section_style = ParagraphStyle(
        'SectionTitle',
        parent=styles['Heading2'],
        fontSize=SECTION_FONT_SIZE,
        spaceBefore=0,
        spaceAfter=0,
        alignment=1  # CENTER
    )
    node_style = ParagraphStyle(
        'NodeSubtitle',
        parent=styles['Normal'],
        fontSize=NODE_FONT_SIZE,
        fontName=BOLD_FONT,
        spaceBefore=0,
        spaceAfter=0,
        alignment=1  # CENTER
    )
    menu_item_style = ParagraphStyle(
        'MenuItem',
        parent=styles['Normal'],
        fontSize=NODE_FONT_SIZE,
        leftIndent=30,  # Indent for bullet point effect
        spaceAfter=20,  # Small space between menu items
        bulletIndent=0,
        bulletFontSize=NODE_FONT_SIZE,
        bulletColor=colors.black
    )
    return title_style, section_style, node_style, menu_item_style
