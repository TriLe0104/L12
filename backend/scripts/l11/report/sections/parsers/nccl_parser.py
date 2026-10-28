"""Parser for NCCL benchmark results."""

import os
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from reportlab.lib.units import inch
from reportlab.platypus import Image as RLImage
import tempfile
from typing import List, Dict, Any, Optional, Tuple

from .base_parser import BaseResultParser


class NCCLParser(BaseResultParser):
    """Parser for NCCL benchmark results."""
    
    NCCL_COLOR_PALETTE = ["#007bff", "#8bdcff", "#04c96a", "#94f18f", "#eca42f", "#ffda6b"]
    
    def __init__(self, is_l10_report: bool = False):
        """Initialize NCCL parser.
        
        Args:
            is_l10_report: Whether this is an L10 report
        """
        super().__init__(is_l10_report)
        self.global_color_mapping = {}
    
    def matches(self, test_name: str) -> bool:
        """Check if test is NCCL-related.
        
        Args:
            test_name: Name of the test
            
        Returns:
            True if test name contains 'nccl'
        """
        return "nccl" in test_name.lower()
    
    def get_columns_to_exclude(self) -> set:
        """Get columns to exclude for NCCL tests.
        
        Returns:
            Set including Num Nodes column
        """
        exclude = super().get_columns_to_exclude()
        exclude.add("Num Nodes")
        return exclude
    
    def process_header(self, header: List[str]) -> List[str]:
        """Process NCCL header with parentheses formatting.
        
        Args:
            header: Original header list
            
        Returns:
            Processed header list
        """
        processed = super().process_header(header)
        # Add line breaks around parentheses for NCCL
        for i in range(len(processed)):
            processed[i] = processed[i].replace("(", "\n(").replace(")", ")\n")
        return processed
    
    def process_data(self, test: Dict[str, Any], header: List[str], data: List[List[str]]) -> Tuple[List[str], List[List[str]]]:
        """Process NCCL data: deduplicate and merge peer SNs.
        
        Args:
            test: Full test dictionary
            header: Processed header list
            data: Data rows
            
        Returns:
            Tuple of (processed_header, processed_data)
        """
        # Deduplicate and merge SNs
        header, data = self._deduplicate_and_merge_sns(header, data)
        
        # Remove columns with no data
        header, data = self._remove_empty_columns(header, data, keep_first_n=3)
        
        return header, data
    
    def build_global_color_mapping(self, tests: List[Dict[str, Any]]) -> None:
        """Build global color mapping for consistent NCCL test colors across all tests.
        
        Args:
            tests: List of all test dictionaries with name, header, and data
        """
        all_nccl_tests = []
        
        for test in tests:
            if not test["data"] or "nccl" not in test["name"].lower():
                continue
            
            # Use parser methods to process header consistently
            exclude_cols = self.get_columns_to_exclude()
            header = [h for h in test["header"] if h not in exclude_cols]
            header = self.process_header(header)
            
            # Find NCCL test columns
            for col in header:
                if col.startswith(("All Reduce", "All Gather", "All To All")) and col not in all_nccl_tests:
                    all_nccl_tests.append(col)
        
        self.global_color_mapping = {t: self.NCCL_COLOR_PALETTE[i % len(self.NCCL_COLOR_PALETTE)] 
                                     for i, t in enumerate(all_nccl_tests)}
    
    def _deduplicate_and_merge_sns(self, header: List[str], data: List[List[str]]) -> Tuple[List[str], List[List[str]]]:
        """Deduplicate rows and merge peer serial numbers into SN column.
        
        Args:
            header: Header list
            data: Data rows
            
        Returns:
            Tuple of (processed_header, processed_data)
        """
        if "SN" not in header:
            return header, data
        
        sn_idx = header.index("SN")
        peer_sns_idx = header.index("Peer SNs") if "Peer SNs" in header else None
        seen_sns = set()
        deduplicated_data = []
        
        for row in data:
            current_sn = row[sn_idx]
            if current_sn not in seen_sns:
                seen_sns.add(current_sn)
                
                # Merge peer SNs into SN column if present
                if peer_sns_idx is not None and row[peer_sns_idx]:
                    row[sn_idx] = self._merge_sns_with_arrows(current_sn, row[peer_sns_idx], seen_sns)
                
                deduplicated_data.append(row)
        
        # Remove Peer SNs column from display
        if peer_sns_idx is not None:
            header.pop(peer_sns_idx)
            for row in deduplicated_data:
                row.pop(peer_sns_idx)
        
        return header, deduplicated_data
    
    def _merge_sns_with_arrows(self, current_sn: str, peer_sns_str: str, seen_sns: set) -> str:
        """Merge current SN with peer SNs using arrow notation.
        
        Args:
            current_sn: Current serial number
            peer_sns_str: Pipe-separated peer serial numbers
            seen_sns: Set to track seen serial numbers
            
        Returns:
            Merged SN string with arrows (if 2 nodes) or line breaks (if more than 2)
        """
        peer_sns = str(peer_sns_str).split("|")
        valid_peers = [p.strip() for p in peer_sns if p.strip() and p.strip() != current_sn]
        
        # Count total nodes: current + valid peers
        total_nodes = 1 + len(valid_peers)
        
        # Mark all peers as seen
        for peer_sn in valid_peers:
            seen_sns.add(peer_sn)
        
        # Build merged SN string
        merged_sn = current_sn
        
        if total_nodes == 2:
            # Exactly 2 nodes: show with arrows
            for peer_sn in valid_peers:
                merged_sn += f'\n     ↕     \n{peer_sn}'
        elif total_nodes > 2:
            # More than 2 nodes: show with line breaks only
            for peer_sn in valid_peers:
                merged_sn += f'\n{peer_sn}'
        
        return merged_sn
    
    def create_additional_elements(self, test: Dict[str, Any], header: List[str], data: List[List[str]], 
                                   width: float, rack_path: str) -> List[Any]:
        """Create NCCL performance chart.
        
        Args:
            test: Full test dictionary
            header: Processed header list
            data: Processed data rows
            width: Available page width
            rack_path: Path to rack logs directory
            
        Returns:
            List containing chart image
        """
        df = pd.DataFrame(data, columns=header)
        
        # Get serial number labels
        if "SN" in df.columns:
            sn_labels = df["SN"]
        elif "Serial Number" in df.columns:
            sn_labels = df["Serial Number"]
        elif "Node" in df.columns:
            sn_labels = df["Node"]
        else:
            sn_labels = pd.Series(df.index)
        
        # Get NCCL test columns that have data
        nccl_tests = [col for col in header if col.startswith(("All Reduce", "All Gather", "All To All"))]
        valid_tests = []
        for t in nccl_tests:
            df[t] = pd.to_numeric(df[t], errors="coerce")
            if df[t].notna().any():
                valid_tests.append(t)
        
        if not valid_tests:
            return []
        
        # Create chart
        fig, ax = plt.subplots(figsize=(10, 6))
        bar_width = 0.12
        xvals = range(len(sn_labels))
        
        # Calculate label font size based on bar width in points
        fig_width_points = fig.get_figwidth() * 72
        x_range = len(sn_labels) + len(valid_tests) * bar_width
        bar_width_points = (bar_width / x_range) * fig_width_points * 0.75
        label_fontsize = min(10, max(6, bar_width_points - 4))
        
        # Plot bars for each test
        for plot_index, test_col in enumerate(valid_tests):
            legend_label = test_col.replace("\n", " ").replace("  ", " ")
            color = self.global_color_mapping.get(test_col, 
                                                  self.NCCL_COLOR_PALETTE[plot_index % len(self.NCCL_COLOR_PALETTE)])
            
            bar_container = ax.bar([xi + plot_index * bar_width for xi in xvals], 
                                  df[test_col], width=bar_width, label=legend_label, color=color)
            
            # Add value labels
            for rect, value in zip(bar_container, df[test_col]):
                if pd.notnull(value) and value > 0:
                    text_label = f"{value:.2f}"
                    bar_height = rect.get_height()
                    
                    # Estimate text height in data units (text width becomes height when rotated 90°)
                    fig_height_points = fig.get_figheight() * 72
                    y_range = ax.get_ylim()[1] - ax.get_ylim()[0]
                    text_height = (len(text_label) * label_fontsize * 0.6 / fig_height_points) * y_range
                    
                    # Place label inside bar if it fits, otherwise at bottom
                    if bar_height >= text_height:
                        label_y = bar_height - 4
                        valign = "top"
                    else:
                        label_y = 8
                        valign = "bottom"
                    
                    ax.text(rect.get_x() + rect.get_width() / 2, label_y, text_label,
                           ha="center", va=valign, color="black", 
                           fontsize=label_fontsize, rotation=90)
        
        # Configure chart
        max_value = df[valid_tests].max().max()
        ax.set_ylim(0, max_value * 1.15)
        ax.set_xticks([xi + bar_width * (len(valid_tests) - 1) / 2 for xi in xvals])
        
        if self.is_l10_report:
            ax.set_xticklabels([])
        else:
            ax.set_xticklabels(sn_labels, rotation=45, ha="right")
            ax.set_xlabel("SNs")
        
        ax.set_ylabel("GB/s")
        ax.legend(loc="upper right", bbox_to_anchor=(1.25, 1))
        plt.subplots_adjust(right=0.8, left=0.08, bottom=0.18, top=0.85)
        plt.tight_layout()
        
        # Save to image
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmpfile:
            plt.savefig(tmpfile.name)
            plt.close(fig)
            return [RLImage(tmpfile.name, width=8 * inch, height=5 * inch)]
