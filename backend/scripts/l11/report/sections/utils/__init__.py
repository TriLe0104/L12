"""Utility functions for PDF report generation."""

from .text_utils import (
    calculate_text_metrics,
    wrap_text_cell,
    split_at_last_pipe,
    wrap_long_text_in_table
)

from .table_utils import (
    calculate_max_column_width,
    distribute_remaining_width,
    create_standard_table_style,
    create_archive_table_style,
    split_at_last_pipe,
    wrap_long_text,
    calculate_column_widths,
    create_table_styles,
    CELL_PADDING,
    DEFAULT_FONT,
    BOLD_FONT
)

from .column_utils import (
    find_column_index,
    find_column_indices,
    filter_excluded_columns,
    remove_empty_columns
)

from .test_utils import TestUtils

__all__ = [
    # Text utilities
    'calculate_text_metrics',
    'wrap_text_cell',
    'split_at_last_pipe',
    'wrap_long_text_in_table',
    
    # Table utilities
    'calculate_max_column_width',
    'distribute_remaining_width',
    'create_standard_table_style',
    'create_archive_table_style',
    'split_at_last_pipe',
    'wrap_long_text',
    'calculate_column_widths',
    'create_table_styles',
    'CELL_PADDING',
    'DEFAULT_FONT',
    'BOLD_FONT',
    
    # Column utilities
    'find_column_index',
    'find_column_indices',
    'filter_excluded_columns',
    'remove_empty_columns',
    
    # Test utilities
    'TestUtils',
]
