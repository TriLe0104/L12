"""Report sections for PDF generation."""

from .s01_introduction import IntroductionSection
from .s02_combined_tables import CombinedTablesSection
from .s03_hardware_details import HardwareDetailsSection
from .s04_pcie_topology import PCIeTopologySection
from .s05_sensor_plots import SensorPlotsSection
from .s06_test_summary import TestSummarySection
from .s07_archive import ArchiveSection

__all__ = [
    'IntroductionSection',
    'CombinedTablesSection',
    'HardwareDetailsSection',
    'PCIeTopologySection',
    'SensorPlotsSection',
    'TestSummarySection',
    'ArchiveSection',
]
