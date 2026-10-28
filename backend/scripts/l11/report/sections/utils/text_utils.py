"""Text wrapping and measurement utilities for PDF reports."""

from reportlab.pdfbase import pdfmetrics
from typing import List, Any, Optional, Tuple


# Constants
CELL_PADDING = 10  # Points of horizontal padding per cell
DEFAULT_FONT = 'Helvetica'


def split_at_last_pipe(text: str, max_chars: int) -> List[str]:
    """Recursively split text at the last pipe character within max_chars limit.
    
    Args:
        text: The text to split
        max_chars: Maximum characters per line
        
    Returns:
        List of text parts split at pipe characters
    """
    if len(text) <= max_chars or "|" not in text:
        return [text]
    
    last_pipe = text.rfind("|", 0, max_chars)
    if last_pipe == -1:
        return [text]
    
    return [text[:last_pipe + 1]] + split_at_last_pipe(text[last_pipe + 1:], max_chars)


def calculate_text_metrics(text: str, available_width: float, font_size: int, font_name: str = DEFAULT_FONT) -> Tuple[float, int]:
    """Calculate text width and maximum characters that fit in available width.
    
    Args:
        text: Text to measure
        available_width: Available width in points
        font_size: Font size
        font_name: Font name (default: Helvetica)
        
    Returns:
        Tuple of (actual_width, max_chars)
    """
    actual_width = pdfmetrics.stringWidth(text, font_name, font_size)
    if actual_width <= available_width:
        return actual_width, len(text)
    
    chars_per_point = len(text) / actual_width
    max_chars = int(available_width * chars_per_point)
    return actual_width, max_chars


def wrap_text_cell(text: str, available_width: float, font_size: int, use_pipe_split: bool, font_name: str = DEFAULT_FONT) -> str:
    """Wrap text in a cell based on available width.
    
    Args:
        text: Text to wrap
        available_width: Available width in points
        font_size: Font size
        use_pipe_split: Whether to split at pipe characters
        font_name: Font name (default: Helvetica)
        
    Returns:
        Wrapped text with newlines
    """
    actual_width, max_chars = calculate_text_metrics(text, available_width, font_size, font_name)
    
    if actual_width <= available_width:
        return text
    
    if use_pipe_split and "|" in text:
        parts = split_at_last_pipe(text, max_chars)
        return '\n'.join(parts)
    
    # Wrap text by chunks
    wrapped_lines = [text[j:j+max_chars] for j in range(0, len(text), max_chars)]
    return '\n'.join(wrapped_lines)


def wrap_long_text_in_table(data: List[List[Any]], col_widths: Optional[List[float]], section_name: str, font_size: int, cell_padding: int = CELL_PADDING) -> None:
    """Wrap long text in table cells based on column widths.
    
    For archive sections, splits at pipe characters when possible.
    For other sections, wraps by character chunks.
    
    Args:
        data: Table data (list of rows)
        col_widths: Column widths in points
        section_name: Name of the section (to determine wrapping strategy)
        font_size: Font size for text measurement
        cell_padding: Cell padding to subtract from available width
    """
    if not col_widths:
        return
    
    is_archive = 'archive' in section_name.lower()
    
    for row_idx, row in enumerate(data):
        if row_idx == 0:  # Skip headers
            continue
        
        for i, cell in enumerate(row):
            if i >= len(col_widths):
                continue
            
            cell_str = str(cell)
            available_width = col_widths[i] - cell_padding
            row[i] = wrap_text_cell(cell_str, available_width, font_size, is_archive)
