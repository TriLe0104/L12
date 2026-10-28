"""Parser for ib_write_bw benchmark results."""

import os
from reportlab.lib.units import inch
from reportlab.platypus import Image as RLImage
from PIL import Image
from typing import List, Dict, Any, Tuple

from .base_parser import BaseResultParser


class IBWriteBWParser(BaseResultParser):
    """Parser for ib_write_bw benchmark results."""
    
    def _apply_custom_styling(self, style: List, header: List[str], table_data: List[List[Any]], data: List[List[Any]]) -> None:
        """Apply ib_write_bw specific styling (span cells for Avg/Peak rows).
        
        Args:
            style: List of style commands to modify
            header: Column headers
            table_data: Full table data
            data: Data rows (without header)
        """
        # Call parent styling first
        super()._apply_custom_styling(style, header, table_data, data)
        
        # Add SPAN commands for ib_write_bw to merge base columns across Avg/Peak rows
        if len(data) > 0:
            num_base_cols = 0
            for i, h in enumerate(header):
                if str(h).strip() == "":
                    break
                num_base_cols += 1
            
            # Merge base columns for each pair of Avg/Peak rows
            for i in range(0, len(data), 2):
                if i + 1 < len(data):
                    data_row_idx = i + 1  # +1 because row 0 is header
                    for col_idx in range(num_base_cols):
                        style.append(("SPAN", (col_idx, data_row_idx), (col_idx, data_row_idx + 1)))
    
    def matches(self, test_name: str) -> bool:
        """Check if test is ib_write_bw.
        
        Args:
            test_name: Name of the test
            
        Returns:
            True if test name contains 'ib_write_bw'
        """
        return "ib_write_bw" in test_name.lower()
    
    def process_data(self, test: Dict[str, Any], header: List[str], data: List[List[str]]) -> Tuple[List[str], List[List[str]]]:
        """Process ib_write_bw data: reorganize Avg/Peak into rows.
        
        Args:
            test: Full test dictionary
            header: Processed header list
            data: Data rows
            
        Returns:
            Tuple of (processed_header, processed_data)
        """
        # Check if we have separate Avg/Peak columns
        if any("Avg BW" in h or "Peak BW" in h for h in header):
            # Find interface columns
            interface_cols = [(i, h.split(" Avg BW")[0]) for i, h in enumerate(header) if "Avg BW" in h]
            base_cols = [h for h in header if "Avg BW" not in h and "Peak BW" not in h]
            base_col_indices = [i for i, h in enumerate(header) if "Avg BW" not in h and "Peak BW" not in h]
            
            # Create new header
            new_header = base_cols + [""] + [iface_name for _, iface_name in interface_cols]
            
            # Reorganize data: each node gets 2 rows (Avg and Peak)
            new_data = []
            for row in data:
                # Avg row
                avg_row = [row[i] if i < len(row) else '' for i in base_col_indices]
                avg_row.append("Avg")
                for col_idx, _ in interface_cols:
                    avg_row.append(row[col_idx] if col_idx < len(row) else '')
                
                # Peak row
                peak_row = [""] * len(base_cols)
                peak_row.append("Peak")
                for col_idx, _ in interface_cols:
                    peak_row.append(row[col_idx + 1] if col_idx + 1 < len(row) else "")
                
                new_data.extend([avg_row, peak_row])
            
            return new_header, new_data
        else:
            # Split combined "avg/peak" values
            iface_prefixes = ["ens", "enp", "eth", "ib", "mlx"]
            split_indices = [i for i, h in enumerate(header) if any(h.startswith(iface) for iface in iface_prefixes)]
            
            header.insert(3, "")
            new_data = []
            
            for row in data:
                if any("/" in str(row[i]) for i in split_indices):
                    # Split into Avg and Peak rows
                    avg_row = []
                    peak_row = []
                    
                    for i, val in enumerate(row):
                        if i in split_indices and "/" in str(val):
                            avg, peak = str(val).split("/", 1)
                            avg_row.append(avg)
                            peak_row.append(peak)
                        elif i in split_indices:
                            avg_row.append(val)
                            peak_row.append("")
                        else:
                            avg_row.append(val)
                            peak_row.append("")
                    
                    avg_row.insert(3, "Avg:")
                    peak_row.insert(3, "Peak:")
                    new_data.extend([avg_row, peak_row])
                else:
                    new_data.append(row)
            
            return header, new_data
    
    def create_additional_elements(self, test: Dict[str, Any], header: List[str], data: List[List[str]], 
                                   width: float, rack_path: str) -> List[Any]:
        """Add interface topology image if available.
        
        Args:
            test: Full test dictionary
            header: Processed header list
            data: Processed data rows
            width: Available page width
            rack_path: Path to rack logs directory
            **kwargs: Additional arguments
            
        Returns:
            List containing topology image if found
        """
        elements = []
        
        # Look for interfaces.png in the project folder (two levels up from rack_path)
        project_path = os.path.dirname(os.path.dirname(rack_path))
        img_path = os.path.join(project_path, "interfaces.png")
        
        if os.path.exists(img_path):
            pil_img = Image.open(img_path)
            img_width, img_height = pil_img.size
            aspect = img_height / img_width
            display_width = 7.5 * inch
            display_height = display_width * aspect
            img = RLImage(img_path, width=display_width, height=display_height)
            elements.append(img)
        
        return elements
