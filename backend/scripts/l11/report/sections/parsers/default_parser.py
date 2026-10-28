"""Default parser for standard benchmark results."""

from typing import List
from .base_parser import BaseResultParser


class DefaultParser(BaseResultParser):
    """Default parser for tests without special formatting."""
    
    def matches(self, test_name: str) -> bool:
        """Matches all tests (fallback parser).
        
        Args:
            test_name: Name of the test
            
        Returns:
            True (matches everything as fallback)
        """
        return True
    
    def process_header(self, header: List[str]) -> List[str]:
        """Process header with basic formatting.
        
        Args:
            header: Original header list
            
        Returns:
            Processed header list
        """
        # Basic processing only
        return [h.replace("np", "\nnp").replace("rocep", "rocep\n") for h in header]
