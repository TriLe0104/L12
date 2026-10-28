# Report Generator Module

Python module for generating L10 (single-node) and L11 (multi-node) PDF reports for hardware testing and monitoring.

## Features

- **L10 Report Generation**: Single-node hardware testing reports with anonymized data
- **L11 Report Generation**: Multi-node rack-level testing reports with full details
- **Benchmark Result Parsing**: Modular parser system for various benchmark types
  - NCCL benchmark parsing with custom visualizations
  - InfiniBand (ib_write_bw) benchmark parsing
  - Extensible parser framework for additional benchmarks
- Automated sensor data plotting and visualization
- Hardware details and configuration tables
- PCIe topology documentation
- Test summary and results tracking
- Archive section for comprehensive data
- Optional watermark support for draft reports

## Installation

```bash
pip install -r requirements.txt
```

## Requirements

- Python 3.8+
- reportlab
- PyPDF2 (optional, for watermark feature)
- Pillow
- pandas
- numpy
- matplotlib

## Usage

### L11 Report (Multi-Node Rack) - Default

```bash
python report_gen.py /path/to/rack/data
```

### L10 Report (Single Node)

```bash
python report_gen.py -l10 /path/to/rack/node_sn
```

### Additional Options

```bash
# With watermark
python report_gen.py -l10 /path/to/rack/node_sn --watermark

# Force recalculate sensor data
python report_gen.py /path/to/rack --force-recalculate

# Customize sensor groups
python report_gen.py /path/to/rack --cpu-temperatures true --gpu-temperatures false
```

## Module Structure

```
report/
├── report_gen.py           # Unified report generator (L10/L11)
├── sections/               # Report section components
│   ├── s01_introduction.py
│   ├── s02_combined_tables.py
│   ├── s03_hardware_details.py
│   ├── s04_pcie_topology.py
│   ├── s05_sensor_plots.py
│   ├── s06_test_summary.py
│   ├── s07_archive.py
│   ├── parsers/           # Benchmark result parsers
│   │   ├── base_parser.py       # Base parser class
│   │   ├── default_parser.py    # Default parser
│   │   ├── ib_write_bw_parser.py # InfiniBand parser
│   │   └── nccl_parser.py       # NCCL parser with visualization
│   ├── resources/         # Report assets (logos, images)
│   └── utils/             # Section-specific utilities
│       ├── column_utils.py
│       ├── table_utils.py
│       ├── test_utils.py
│       └── text_utils.py
└── utils/                 # Core utilities
    ├── config_manager.py
    ├── data_manager.py
    ├── data_parser.py
    ├── header_footer.py
    ├── html_builder.py    # HTML element builder for reportlab
    ├── plot_manager.py
    ├── plot_over_time.py  # Standalone Redfish monitoring tool
    └── watermark.py       # PDF watermark utility
```

## License

Internal use only.
