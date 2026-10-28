# -*- coding: utf-8 -*-
"""
Report Generator Package
This package contains components for generating L10 and L11 PDF reports.
"""

# Report generator
from .report_gen import ReportGen

# Report sections
from .sections import (
    IntroductionSection,
    CombinedTablesSection,
    HardwareDetailsSection,
    PCIeTopologySection,
    SensorPlotsSection,
    TestSummarySection,
    ArchiveSection,
)

# Utilities
from .utils.data_parser import (
    parse_log_file,
    parse_software_report_csv,
)

__all__ = [
    # Report generators
    'ReportGen',
    
    # Report sections
    'IntroductionSection',
    'CombinedTablesSection',
    'HardwareDetailsSection',
    'PCIeTopologySection',
    'SensorPlotsSection',
    'TestSummarySection',
    'ArchiveSection',
    
    # Data parser functions
    'parse_log_file',
    'parse_software_report_csv',
]