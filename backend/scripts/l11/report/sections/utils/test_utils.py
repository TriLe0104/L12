import re
from typing import List, Dict, Any


class TestUtils:
    """Utilities for parsing and processing test data from CSV files."""

    @staticmethod
    def parse_tests_from_csv(csv_path: str) -> List[Dict[str, Any]]:
        """Parse test data from a CSV file with test names and results."""
        import csv
        tests = []
        
        with open(csv_path, "r", encoding="utf-8", newline='') as f:
            lines = f.read().split('\n')
        
        i = 0
        # Skip first line if it's a title
        if i < len(lines) and lines[i].strip() and "," not in lines[i]:
            i += 1
        # Skip any empty lines
        while i < len(lines) and not lines[i].strip():
            i += 1
        
        while i < len(lines):
            # Look for test name (line without comma)
            if lines[i].strip() and "," not in lines[i]:
                test_name = lines[i].strip()
                i += 1
                # Skip empty lines
                while i < len(lines) and not lines[i].strip():
                    i += 1
                if i >= len(lines):
                    break
                
                # Parse header and data using csv module for proper handling
                if "," in lines[i]:
                    # Collect all lines until next test or end
                    csv_lines = []
                    while i < len(lines) and lines[i].strip() and (i == len(lines) - 1 or "," in lines[i] or (i + 1 < len(lines) and "," in lines[i + 1])):
                        csv_lines.append(lines[i])
                        i += 1
                        # Stop if we hit a test name (no comma and not empty)
                        if i < len(lines) and lines[i].strip() and "," not in lines[i]:
                            break
                    
                    if csv_lines:
                        # Use csv.reader to properly parse CSV data
                        import io
                        csv_text = '\n'.join(csv_lines)
                        reader = csv.reader(io.StringIO(csv_text))
                        rows = list(reader)
                        
                        if rows:
                            header = [h.strip() for h in rows[0]]
                            data = []
                            for row in rows[1:]:
                                # Only include rows that have the same number of columns as header
                                if len(row) == len(header):
                                    data.append([v.strip() for v in row])
                            tests.append({"name": test_name, "header": header, "data": data})
                else:
                    i += 1
            else:
                i += 1
        return tests

    @staticmethod
    def determine_test_status(test: Dict[str, Any]) -> str:
        """Determine if a test passed or failed based on its data."""
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