# L11 wrapper scripts (vendored)

Copied from the L11 `nburn-wrapper` toolkit so L12 can run the same sanity,
BOM, and NVIDIA bench workflow against GB300 nodes.

L12 does **not** shell out to `AIO.sh` on Windows. The FastAPI sanity engine
(`app/sanity.py`) reimplements FW / SW / BOM / PSU / Voltage / SEL over
Redfish (and SSH when the OS is reachable). These scripts stay here so they
can be copied onto a Linux node or inspected from the Testing page.

## Layout

| Path | Role |
| --- | --- |
| `sanitycheck/01-fw-sw_checks/` | Firmware inventory + software capture |
| `sanitycheck/02-bom_checks/` | `01-trilsanitychk.sh` golden BOM compare/export |
| `sanitycheck/03-health_checks/` | PSU, voltage rails, SEL critical errors |
| `utils/capture_golden.sh` | Capture BOM/FW/SW golden from one node |
| `scripts/run_sanity_check.sh` | Parallel per-node sanity orchestrator |
| `benchmarks/20x*` | NVIDIA-relevant benches (stress-ng, SAT, mprime, fio, IB, NCCL, DCGM, nv_stream) |
| `report/` | Original L10/L11 `report_gen.py` (needs Linux rack dirs + extra Python deps) |

AMD-only benches (RCCL, rocHPL, oneAPI STREAM) were left out of this tree.

## Golden files

L12 stores live golden files under `backend/data/l11/golden/`:

- `bom_golden.json`
- `fw_golden.json`
- `sw_golden.json`

`bom_golden.example.json` is a sample shape from the original wrapper.
Do not commit BMC passwords. The original sanity FAIL dump printed `bmc_pwd`;
L12 never does that.

## Reports

L12 generates L10 (per-node) and L11 (rack) PDF/CSV/JSON via
`app/l11_report.py` using reportlab. The vendored `report/report_gen.py` is
the original generator for a wrapper `racks/<NNN>/` directory layout.
