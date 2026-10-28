import os
from reportlab.platypus import Paragraph, PageBreak
from typing import List, Dict, Any, Optional

from .parsers import NCCLParser, IBWriteBWParser, DefaultParser
from utils.html_builder import Html


class TestSummarySection:
    """Generates test summary sections in PDF reports."""
    
    # Constants
    SUMMARY_DIR = "summary_report"
    CSV_EXTENSION = ".csv"
    CSV_KEYWORD = "test_summary"
    CSV_DELIMITER = ","
    SN_COLUMNS = ["SN", "SERIAL NUMBER", "NODE SN"]
    STATUS_PASS = "PASS"
    COLOR_PASS = "green"
    COLOR_FAIL = "red"
    
    def __init__(self, rack_path: str, is_l10_report: bool = False):
        self.rack_path = rack_path
        self.parsers = [
            NCCLParser(is_l10_report=is_l10_report),
            IBWriteBWParser(is_l10_report=is_l10_report),
            DefaultParser(is_l10_report=is_l10_report),
        ]
        self._processed_tests = None
    
    def add_section(self, story: List, width: float, styles: Any, title_style: Any, 
                   section_style: Any, menu_item_style: Any, node_sn: Optional[str] = None) -> None:
        """Add complete test section including header, TOC, and content."""
        self._process_tests(width, styles, section_style, node_sn)
        
        if not self._processed_tests:
            return
        
        # Section header
        story.append(PageBreak())
        story.append(Paragraph(Html.anchor('test'), styles['Normal']))
        story.append(Paragraph("Test Summary", title_style))
        story.append(Paragraph(Html.bold("Included Tests:"), menu_item_style))
        
        # TOC entries with status
        for t in self._processed_tests:
            color = self.COLOR_PASS if t["status"] == self.STATUS_PASS else self.COLOR_FAIL
            status_html = Html.bold_colored(t['status'], color)
            link_text = f"• {t['name']} - {status_html}"
            toc_entry = Html.link(f"#{t['name']}_page", link_text)
            story.append(Paragraph(toc_entry, menu_item_style))
        
        story.append(PageBreak())
        
        # Test content
        for t in self._processed_tests:
            story.extend(t["elements"])
    
    def _process_tests(self, width: float, styles: Any, section_style: Any, 
                      node_sn: Optional[str] = None) -> None:
        """Parse CSV, run parsers once, cache results."""
        if self._processed_tests is not None:
            return
        
        csv_path = self._get_latest_csv()
        if not csv_path:
            self._processed_tests = []
            return
        
        tests = self._parse_csv(csv_path)
        if node_sn:
            tests = self._filter_by_node(tests, node_sn)
        
        # Build NCCL color mapping
        nccl_parser = next((p for p in self.parsers if isinstance(p, NCCLParser)), None)
        if nccl_parser:
            nccl_parser.build_global_color_mapping(tests)
        
        # Run parsers and cache
        self._processed_tests = []
        for test in tests:
            if test["data"]:
                parser = next((p for p in self.parsers if p.matches(test["name"])), 
                            self.parsers[-1])
                elements, status = parser.generate_elements(
                    test, width, styles, section_style, self.rack_path)
                self._processed_tests.append({
                    "name": test["name"], 
                    "status": status, 
                    "elements": elements
                })
    
    def _get_latest_csv(self) -> Optional[str]:
        """Get path to latest test summary CSV."""
        summary_dir = os.path.join(self.rack_path, self.SUMMARY_DIR)
        if not os.path.exists(summary_dir):
            return None
        files = [f for f in os.listdir(summary_dir) 
                if f.endswith(self.CSV_EXTENSION) and self.CSV_KEYWORD in f]
        if not files:
            return None
        files.sort(key=lambda f: os.path.getmtime(os.path.join(summary_dir, f)), reverse=True)
        return os.path.join(summary_dir, files[0])
    
    def _parse_csv(self, csv_path: str) -> List[Dict[str, Any]]:
        """Parse test data from CSV file."""
        with open(csv_path, "r", encoding="utf-8") as f:
            lines = [line.rstrip() for line in f if line.rstrip()]
        
        tests = []
        i = 0
        
        # Skip title line if it doesn't contain delimiter
        if i < len(lines) and self.CSV_DELIMITER not in lines[i] and not lines[i][0].isdigit():
            i += 1
        
        while i < len(lines):
            # Test name is a line without delimiter
            if self.CSV_DELIMITER not in lines[i]:
                test_name = lines[i].strip()
                i += 1
                
                # Next line should be header
                if i < len(lines) and self.CSV_DELIMITER in lines[i]:
                    header = [h.strip() for h in lines[i].split(self.CSV_DELIMITER)]
                    i += 1
                    
                    # Collect data rows
                    data = []
                    while i < len(lines) and self.CSV_DELIMITER in lines[i]:
                        row = [v.strip() for v in lines[i].split(self.CSV_DELIMITER)]
                        if len(row) == len(header):
                            data.append(row)
                        i += 1
                    
                    tests.append({"name": test_name, "header": header, "data": data})
            else:
                i += 1
        
        return tests
    
    def _filter_by_node(self, tests: List[Dict[str, Any]], node_sn: str) -> List[Dict[str, Any]]:
        """Filter tests to only include rows for specific node."""
        filtered = []
        for test in tests:
            sn_idx = next((i for i, col in enumerate(test["header"]) 
                          if col.strip().upper() in self.SN_COLUMNS), None)
            
            if sn_idx is None:
                filtered.append(test)
            else:
                data = [row for row in test["data"] 
                       if len(row) > sn_idx and row[sn_idx].strip() == node_sn]
                filtered.append({
                    "name": test["name"], 
                    "header": test["header"], 
                    "data": data
                })
        
        return filtered
