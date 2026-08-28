"""Spine-leaf InfiniBand fabric for the Firmus GB300 campus.

One Quantum-2 leaf per rack row, eight spines in the core. Generated from
the live hall/rack inventory so the 3D map, port table, and traffic feed
always match.
"""

from __future__ import annotations

import hashlib
import math
import time

from .models import DataHall, Rack

SPINE_COUNT = 8
LINK_SPEED = "800 Gbps"
LINK_SPEED_GBPS = 800.0


def _hid(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:10]


def build_fabric(halls: list[DataHall]) -> dict:
    nodes: list[dict] = []
    links: list[dict] = []
    ports: list[dict] = []

    spines = []
    for i in range(SPINE_COUNT):
        node = {
            "id": f"SP-{i + 1:02d}",
            "name": f"SP-{i + 1:02d}",
            "label": f"Quantum-2 Spine {i + 1:02d}",
            "role": "spine",
            "hall_id": None,
            "hall_name": None,
            "row": None,
            "ports": 64,
        }
        spines.append(node)
        nodes.append(node)

    for hall in halls:
        rows: dict[int, list[Rack]] = {}
        for rack in hall.racks:
            rows.setdefault(rack.y, []).append(rack)
        for row_i, y in enumerate(sorted(rows)):
            racks = sorted(rows[y], key=lambda r: r.x)
            leaf_id = f"{hall.name}-LF-R{row_i + 1:02d}"
            leaf = {
                "id": leaf_id,
                "name": leaf_id,
                "label": f"{hall.name} Leaf R{row_i + 1:02d}",
                "role": "leaf",
                "hall_id": hall.id,
                "hall_name": hall.name,
                "row": row_i + 1,
                "row_y": y,
                "ports": 64,
            }
            nodes.append(leaf)
            for col, rack in enumerate(racks):
                rack_node = {
                    "id": f"rack:{rack.id}",
                    "name": rack.name,
                    "label": rack.name,
                    "role": "rack",
                    "hall_id": hall.id,
                    "hall_name": hall.name,
                    "row": row_i + 1,
                    "rack_id": rack.id,
                    "ports": 2,
                    "power_state": getattr(rack, "power_state", "on"),
                }
                nodes.append(rack_node)
                down_port = col + 1
                active = (getattr(rack, "power_state", "on") or "on") != "off"
                state = "Active" if active else "Down"
                link_id = f"{leaf_id}->{rack.id}"
                links.append(
                    {
                        "id": link_id,
                        "from_id": leaf_id,
                        "to_id": f"rack:{rack.id}",
                        "from_name": leaf_id,
                        "to_name": rack.name,
                        "from_port": str(down_port),
                        "to_port": "1",
                        "role": "downlink",
                        "speed": LINK_SPEED,
                        "state": state,
                        "hall_id": hall.id,
                    }
                )
                ports.append(
                    {
                        "local_system": leaf_id,
                        "local_port": str(down_port),
                        "peer_system": rack.name,
                        "peer_port": "1",
                        "state": state,
                        "speed": LINK_SPEED if active else "N/A",
                        "cable_pn": "MCP7Y00-N003",
                        "role": "downlink",
                        "hall_name": hall.name,
                    }
                )
                ports.append(
                    {
                        "local_system": rack.name,
                        "local_port": "1",
                        "peer_system": leaf_id,
                        "peer_port": str(down_port),
                        "state": state,
                        "speed": LINK_SPEED if active else "N/A",
                        "cable_pn": "MCP7Y00-N003",
                        "role": "host",
                        "hall_name": hall.name,
                    }
                )
            hall_index = sorted([h.name for h in halls]).index(hall.name)
            for si, spine in enumerate(spines):
                up_port = 33 + si
                spine_port = min(64, max(1, hall_index * 8 + row_i + 1))
                link_id = f"{leaf_id}->{spine['id']}"
                links.append(
                    {
                        "id": link_id,
                        "from_id": leaf_id,
                        "to_id": spine["id"],
                        "from_name": leaf_id,
                        "to_name": spine["id"],
                        "from_port": str(up_port),
                        "to_port": str(spine_port),
                        "role": "uplink",
                        "speed": LINK_SPEED,
                        "state": "Active",
                        "hall_id": hall.id,
                    }
                )
                ports.append(
                    {
                        "local_system": leaf_id,
                        "local_port": str(up_port),
                        "peer_system": spine["id"],
                        "peer_port": str(spine_port),
                        "state": "Active",
                        "speed": LINK_SPEED,
                        "cable_pn": "MMA4Z00-NS",
                        "role": "uplink",
                        "hall_name": hall.name,
                    }
                )
                ports.append(
                    {
                        "local_system": spine["id"],
                        "local_port": str(spine_port),
                        "peer_system": leaf_id,
                        "peer_port": str(up_port),
                        "state": "Active",
                        "speed": LINK_SPEED,
                        "cable_pn": "MMA4Z00-NS",
                        "role": "spine",
                        "hall_name": hall.name,
                    }
                )

    for p in ports:
        if p["role"] == "host":
            p["physical_port"] = "OSFP / HCA-1"
        else:
            p["physical_port"] = f"QSFP-DD {p['local_port']}"

    active = [p for p in ports if p["state"] == "Active"]
    return {
        "nodes": nodes,
        "links": links,
        "ports": ports,
        "summary": {
            "spines": SPINE_COUNT,
            "leaves": sum(1 for n in nodes if n["role"] == "leaf"),
            "racks": sum(1 for n in nodes if n["role"] == "rack"),
            "total_ports": len(ports),
            "active_ports": len(active),
            "speed": LINK_SPEED,
        },
    }


def live_traffic(fabric: dict) -> dict:
    t = time.time()
    per_node: dict[str, dict] = {}
    per_link: list[dict] = []

    def bump(node_id: str, tx: float, rx: float) -> None:
        slot = per_node.setdefault(node_id, {"tx_gbps": 0.0, "rx_gbps": 0.0})
        slot["tx_gbps"] += tx
        slot["rx_gbps"] += rx

    for link in fabric["links"]:
        if link["state"] != "Active":
            per_link.append(
                {
                    "id": link["id"],
                    "from_id": link["from_id"],
                    "to_id": link["to_id"],
                    "from_name": link["from_name"],
                    "to_name": link["to_name"],
                    "role": link["role"],
                    "tx_gbps": 0.0,
                    "rx_gbps": 0.0,
                    "util_pct": 0.0,
                    "state": "Down",
                }
            )
            continue
        seed = int(_hid(link["id"]), 16)
        phase = (seed % 1000) / 1000 * math.tau
        base = 90 + (seed % 180) if link["role"] == "uplink" else 18 + (seed % 40)
        amp = 70 if link["role"] == "uplink" else 16
        tx = max(0.4, base + amp * math.sin(t / 8.0 + phase))
        rx = max(0.3, base * 0.82 + amp * 0.7 * math.sin(t / 11.0 + phase * 1.4))
        util = min(99.0, (tx + rx) / (2 * LINK_SPEED_GBPS) * 100)
        per_link.append(
            {
                "id": link["id"],
                "from_id": link["from_id"],
                "to_id": link["to_id"],
                "from_name": link["from_name"],
                "to_name": link["to_name"],
                "role": link["role"],
                "tx_gbps": round(tx, 2),
                "rx_gbps": round(rx, 2),
                "util_pct": round(util, 1),
                "state": "Active",
            }
        )
        bump(link["from_id"], tx, rx)
        bump(link["to_id"], rx, tx)

    for slot in per_node.values():
        slot["tx_gbps"] = round(slot["tx_gbps"], 2)
        slot["rx_gbps"] = round(slot["rx_gbps"], 2)
        slot["util_pct"] = round(min(99.0, (slot["tx_gbps"] + slot["rx_gbps"]) / (16 * LINK_SPEED_GBPS) * 100), 1)

    total_tx = sum(l["tx_gbps"] for l in per_link)
    active = sum(1 for l in per_link if l["state"] == "Active")
    return {
        "ts": t,
        "active_links": active,
        "total_tx_gbps": round(total_tx, 1),
        "total_rx_gbps": round(sum(l["rx_gbps"] for l in per_link), 1),
        "nodes": per_node,
        "links": sorted(per_link, key=lambda l: -l["util_pct"])[:80],
        "all_links": per_link,
    }
