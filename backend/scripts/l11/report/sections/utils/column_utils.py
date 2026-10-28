"""Column finding and manipulation utilities for PDF reports."""

from typing import List, Optional, Tuple, Any


def find_column_index(headers: List[str], column_name: str) -> int:
    """Find the index of a column by name.
    
    Args:
        headers: List of header names
        column_name: Column name to find
        
    Returns:
        Column index or -1 if not found
    """
    try:
        return headers.index(column_name)
    except ValueError:
        return -1


def find_column_indices(header: List[str], 
                       sn_names: Optional[List[str]] = None,
                       result_names: Optional[List[str]] = None,
                       duration_names: Optional[List[str]] = None) -> Tuple[Optional[int], Optional[int], Optional[int]]:
    """Find indices of special columns (SN, Result, Duration).
    
    Args:
        header: List of column headers
        sn_names: List of possible SN column names (default: standard names)
        result_names: List of possible result column names (default: standard names)
        duration_names: List of possible duration column names (default: standard names)
        
    Returns:
        Tuple of (sn_idx, result_idx, duration_idx)
    """
    if sn_names is None:
        sn_names = ["SN", "SERIAL NUMBER", "NODE SN", "NODE"]
    if result_names is None:
        result_names = ["result", "status"]
    if duration_names is None:
        duration_names = ["duration"]
    
    sn_idx = result_idx = duration_idx = None
    
    for idx, col_name in enumerate(header):
        col_upper = str(col_name).strip().upper()
        col_lower = str(col_name).strip().lower()
        
        if col_upper in sn_names:
            sn_idx = idx
        if col_lower in result_names:
            result_idx = idx
        if col_lower in duration_names:
            duration_idx = idx
    
    return sn_idx, result_idx, duration_idx


def filter_excluded_columns(header: List[str], data: List[List[str]], excluded_columns: set) -> Tuple[List[str], List[List[str]]]:
    """Filter out excluded columns from header and data.
    
    Args:
        header: List of column headers
        data: List of data rows
        excluded_columns: Set of column names to exclude
        
    Returns:
        Tuple of (filtered_header, filtered_data)
    """
    keep_indices = [i for i, h in enumerate(header) if h not in excluded_columns]
    filtered_header = [header[i] for i in keep_indices]
    filtered_data = [[row[i] if i < len(row) else '' for i in keep_indices] for row in data]
    
    return filtered_header, filtered_data


def remove_empty_columns(header: List[str], data: List[List[Any]], min_required_cols: int = 3) -> Tuple[List[str], List[List[Any]]]:
    """Remove columns that have all empty values (excluding header).
    
    Args:
        header: List of column headers
        data: List of data rows
        min_required_cols: Minimum number of columns to always keep
        
    Returns:
        Tuple of (filtered_header, filtered_data)
    """
    cols_to_keep = []
    for col_idx in range(len(header)):
        has_data = False
        for row in data:
            if col_idx < len(row) and row[col_idx] and str(row[col_idx]).strip():
                has_data = True
                break
        # Always keep first N columns or columns with data
        if has_data or col_idx < min_required_cols:
            cols_to_keep.append(col_idx)
    
    # Only filter if needed
    if cols_to_keep != list(range(len(header))):
        filtered_header = [header[i] for i in cols_to_keep]
        filtered_data = [[row[i] if i < len(row) else '' for i in cols_to_keep] for row in data]
        return filtered_header, filtered_data
    
    return header, data
