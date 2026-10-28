"""Base parser class for benchmark results."""

from typing import List, Dict, Any, Tuple, Optional
from abc import ABC, abstractmethod
from reportlab.platypus import Table, TableStyle, Paragraph, KeepTogether
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics

from utils.html_builder import Html


class BaseResultParser(ABC):
    """Base class for result parsers."""
    
    # Constants
    DEFAULT_FONT = 'Helvetica'
    BOLD_FONT = 'Helvetica-Bold'
    FONT_SIZE = 8
    
    def __init__(self, is_l10_report: bool = False):
        """Initialize parser.
        
        Args:
            is_l10_report: Whether this is an L10 report (anonymized)
        """
        self.is_l10_report = is_l10_report
    
    @abstractmethod
    def matches(self, test_name: str) -> bool:
        """Check if this parser should handle the given test.
        
        Args:
            test_name: Name of the test
            
        Returns:
            True if this parser handles this test type
        """
        pass
    
    def determine_test_status(self, test: Dict[str, Any]) -> str:
        """Determine if test passed or failed based on result column.
        
        Args:
            test: Test dictionary with header and data
            
        Returns:
            'PASS' if all tests passed, 'FAIL' otherwise
        """
        if not test["data"]:
            return "FAIL"
        header = test["header"]
        result_idx = None
        for idx, col in enumerate(header):
            if col.strip().lower() in ["result", "status"]:
                result_idx = idx
                break
        if result_idx is None:
            return "FAIL"
        all_pass = True
        for row in test["data"]:
            if len(row) > result_idx:
                val = row[result_idx].strip().upper()
                if val != "PASS":
                    all_pass = False
                    break
        return "PASS" if all_pass else "FAIL"
    
    def generate_elements(self, test: Dict[str, Any], width: float, styles: Any, 
                         section_style: Any, rack_path: str) -> Tuple[List[Any], str]:
        """Generate complete ReportLab elements for this test.
        
        Args:
            test: Test dictionary with name, header, and data
            width: Available page width
            styles: ReportLab styles
            section_style: Paragraph style for section titles
            rack_path: Path to rack logs directory
            
        Returns:
            Tuple of (ReportLab elements to add to story, test status 'PASS' or 'FAIL')
        """
        # Determine test status
        status = self.determine_test_status(test)
        
        if not test["data"]:
            return [], status
        
        # Filter columns
        header, data = self._filter_columns(test["header"], test["data"])
        
        # Process header and data
        header = self.process_header(header)
        header, data = self.process_data(test, header, data)
        
        # Create table and build elements
        table = self._create_table(header, data, width)
        elements = self._build_base_elements(test["name"], table, styles, section_style)
        
        # Add custom elements (charts, images, etc.)
        additional = self.create_additional_elements(test, header, data, width, rack_path)
        elements.extend(additional)
        
        return [KeepTogether(elements)], status
    
    def get_columns_to_exclude(self) -> set:
        """Get columns that should be excluded from display.
        
        Returns:
            Set of column names to exclude
        """
        return {"Node", "Rack", "Time started", "Time Started", "Time Completed", "Time Completed"}
    
    def _filter_columns(self, header: List[str], data: List[List[str]]) -> Tuple[List[str], List[List[str]]]:
        """Filter out excluded columns from header and data.
        
        Args:
            header: Original header list
            data: Original data rows
            
        Returns:
            Tuple of (filtered_header, filtered_data)
        """
        exclude_cols = self.get_columns_to_exclude()
        keep_indices = [i for i, h in enumerate(header) if h not in exclude_cols]
        filtered_header = [header[i] for i in keep_indices]
        filtered_data = [[row[i] if i < len(row) else '' for i in keep_indices] for row in data]
        return filtered_header, filtered_data
    
    def _remove_empty_columns(self, header: List[str], data: List[List[str]], 
                             keep_first_n: int = 3) -> Tuple[List[str], List[List[str]]]:
        """Remove columns that have no data.
        
        Args:
            header: Header list
            data: Data rows
            keep_first_n: Always keep first N columns regardless of content
            
        Returns:
            Tuple of (filtered_header, filtered_data)
        """
        cols_to_keep = []
        for col_idx in range(len(header)):
            # Always keep first N columns
            if col_idx < keep_first_n:
                cols_to_keep.append(col_idx)
                continue
            
            # Check if column has any data
            has_data = False
            for row in data:
                if col_idx < len(row) and row[col_idx] and str(row[col_idx]).strip():
                    has_data = True
                    break
            
            if has_data:
                cols_to_keep.append(col_idx)
        
        # Only filter if needed
        if cols_to_keep == list(range(len(header))):
            return header, data
        
        filtered_header = [header[i] for i in cols_to_keep]
        filtered_data = [[row[i] if i < len(row) else '' for i in cols_to_keep] for row in data]
        return filtered_header, filtered_data
    
    def process_header(self, header: List[str]) -> List[str]:
        """Process and format header columns.
        
        Args:
            header: Original header list
            
        Returns:
            Processed header list
        """
        # Default: add line breaks for better formatting
        processed = [h.replace("np", "\nnp").replace("rocep", "rocep\n") for h in header]
        return processed
    
    def process_data(self, test: Dict[str, Any], header: List[str], data: List[List[str]]) -> Tuple[List[str], List[List[str]]]:
        """Process test data and header.
        
        Args:
            test: Full test dictionary
            header: Processed header list
            data: Data rows
            
        Returns:
            Tuple of (processed_header, processed_data)
        """
        # Default: return as-is
        return header, data
    
    def create_additional_elements(self, test: Dict[str, Any], header: List[str], data: List[List[str]], 
                                   width: float, rack_path: str) -> List[Any]:
        """Create additional elements like charts or images.
        
        Args:
            test: Full test dictionary
            header: Processed header list
            data: Processed data rows
            width: Available page width
            rack_path: Path to rack logs directory
            
        Returns:
            List of ReportLab elements to add
        """
        # Default: no additional elements
        return []
    
    def _calculate_column_widths(self, table_data: List[List[Any]], width: float, header: List[str]) -> List[float]:
        """Calculate column widths based on content.
        
        Args:
            table_data: Table data including header
            width: Available page width
            header: Column headers
            
        Returns:
            List of column widths
        """
        n_cols = len(table_data[0])
        max_widths = [0.0] * n_cols
        
        # Calculate maximum widths needed for each column
        for row in table_data:
            for i, cell in enumerate(row):
                if i >= len(max_widths):
                    continue
                cell_str = max(str(cell).split("\n"), key=len)
                w = pdfmetrics.stringWidth(cell_str, self.DEFAULT_FONT, self.FONT_SIZE) + 4
                max_widths[i] = max(max_widths[i], w)
        
        # Find fixed-width columns
        sn_idx, result_idx, duration_idx = self._find_special_columns(header)
        
        fixed_indices = []
        fixed_widths = []
        
        for idx in [sn_idx, result_idx, duration_idx]:
            if idx is not None and idx not in fixed_indices:
                fixed_indices.append(idx)
                fixed_widths.append(max_widths[idx])
        
        # Distribute remaining width
        remaining_indices = [i for i in range(n_cols) if i not in fixed_indices]
        remaining_max_widths = [max_widths[i] for i in remaining_indices]
        
        fixed_total = sum(fixed_widths)
        remaining_page_width = width - fixed_total
        remaining_total = sum(remaining_max_widths)
        
        col_widths = [0.0] * n_cols
        
        # Set fixed widths
        for idx, w in zip(fixed_indices, fixed_widths):
            col_widths[idx] = w
        
        # Distribute remaining width proportionally
        if remaining_total > 0 and remaining_indices:
            scale = remaining_page_width / remaining_total
            for i, idx in enumerate(remaining_indices):
                col_widths[idx] = remaining_max_widths[i] * scale
        
        return col_widths
    
    def _find_special_columns(self, header: List[str]) -> Tuple[Optional[int], Optional[int], Optional[int]]:
        """Find indices of special columns (SN, Result, Duration).
        
        Args:
            header: List of column headers
            
        Returns:
            Tuple of (sn_idx, result_idx, duration_idx)
        """
        sn_idx = result_idx = duration_idx = None
        
        for idx, col_name in enumerate(header):
            col_upper = str(col_name).strip().upper()
            col_lower = str(col_name).strip().lower()
            
            if col_upper in ["SN", "SERIAL NUMBER", "NODE SN", "NODE"]:
                sn_idx = idx
            if col_lower in ["result", "status"]:
                result_idx = idx
            if col_lower == "duration":
                duration_idx = idx
        
        return sn_idx, result_idx, duration_idx
    
    def _create_table(self, header: List[str], data: List[List[str]], width: float) -> Table:
        """Create styled table from header and data.
        
        Args:
            header: Column headers
            data: Data rows
            width: Available page width
            
        Returns:
            Styled Table object
        """
        table_data = [header] + data
        col_widths = self._calculate_column_widths(table_data, width, header)
        table = Table(table_data, repeatRows=1, colWidths=col_widths)
        
        # Apply styling
        style = self._create_base_table_style()
        self._apply_custom_styling(style, header, table_data, data)
        table.setStyle(TableStyle(style))
        
        return table
    
    def _build_base_elements(self, test_name: str, table: Table, styles: Any, 
                            section_style: Any) -> List[Any]:
        """Build base elements (anchor, title, table).
        
        Args:
            test_name: Name of the test
            table: Styled table
            styles: ReportLab styles
            section_style: Paragraph style for section title
            
        Returns:
            List of base elements
        """
        return [
            Paragraph(Html.anchor(f"{test_name}_page"), styles['Normal']),
            Paragraph(Html.bold(test_name), section_style),
            table
        ]
    
    def _create_base_table_style(self) -> List:
        """Create base table style.
        
        Returns:
            List of style commands
        """
        return [
            ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.black),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("FONTNAME", (0, 0), (-1, 0), self.BOLD_FONT),
            ("FONTSIZE", (0, 0), (-1, -1), self.FONT_SIZE),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ]
    
    def _apply_custom_styling(self, style: List, header: List[str], table_data: List[List[Any]], data: List[List[Any]]) -> None:
        """Apply custom styling to table.
        
        Args:
            style: List of style commands to modify
            header: Column headers
            table_data: Full table data
            data: Data rows (without header)
        """
        # Color code result column
        result_col = None
        for idx, col_name in enumerate(header):
            if str(col_name).strip().lower() in ["result", "status"]:
                result_col = idx
                break
        
        if result_col is not None:
            for row_idx, row in enumerate(table_data[1:], start=1):
                val = str(row[result_col]).strip().upper()
                if val == "PASS":
                    style.append(("TEXTCOLOR", (result_col, row_idx), (result_col, row_idx), colors.green))
                    style.append(("FONTNAME", (result_col, row_idx), (result_col, row_idx), self.BOLD_FONT))
                elif val == "FAIL":
                    style.append(("TEXTCOLOR", (result_col, row_idx), (result_col, row_idx), colors.red))
                    style.append(("FONTNAME", (result_col, row_idx), (result_col, row_idx), self.BOLD_FONT))
