import inspect

from app.agent import (
    _coalesce_ui,
    _norm_page,
    _wants_dynamic_power,
    tool_highlight_ui,
    tool_open_page,
    tool_set_power_cap,
)


def _path(raw: str) -> str:
    dest, _tab = _norm_page(raw)
    return dest


def test_power_talk_opens_dynamic_power():
    for raw in (
        "limiter",
        "limitter",
        "power limiter",
        "power limitter",
        "power limit",
        "power cap",
        "dynamic power",
        "maxlps",
        "/maxlps",
        "power",
        "lps",
        "cluster power",
        "gpu power",
        "closed loop",
    ):
        assert _path(raw) == "/maxlps", raw
        assert tool_open_page(raw)["path"] == "/maxlps", raw


def test_cluster_and_tests_stay_put():
    assert _path("cluster") == "/cluster"
    assert _path("/cluster") == "/cluster"
    assert _path("overview") == "/cluster"
    assert tool_open_page("racks")["path"] == "/cluster?tab=racks"
    assert _path("testing") == "/testing"
    assert _path("settings") == "/settings"
    assert not _wants_dynamic_power("power on")
    assert not _wants_dynamic_power("power off GB300-01")
    assert _path("power on") != "/maxlps"


def test_highlight_limiter_navigates_maxlps():
    for target in ("limiter", "limitter", "power limiter", "power limitter", "maxlps", "dynamic power", "power"):
        out = tool_highlight_ui(target)
        ui = out["ui"]
        nav = next(c for c in ui if c["kind"] == "navigate")
        hit = next(c for c in ui if c["kind"] == "highlight")
        assert nav["path"] == "/maxlps", target
        assert hit["target"] == "limiter", target


def test_set_power_cap_points_at_maxlps():
    src = inspect.getsource(tool_set_power_cap)
    assert 'path="/maxlps"' in src
    assert 'path="/cluster"' not in src


def test_coalesce_keeps_dynamic_power():
    ui = [
        {"kind": "navigate", "path": "/maxlps"},
        {"kind": "navigate", "path": "/cluster?tab=overview"},
        {"kind": "click", "target": "Overview"},
        {"kind": "highlight", "action": "look", "target": "overview", "label": "cluster status", "ids": []},
    ]
    out = _coalesce_ui(ui)
    assert [c["kind"] for c in out] == ["navigate", "highlight"]
    assert out[0]["path"] == "/maxlps"
    assert out[1]["target"] == "limiter"


def test_coalesce_leaves_cluster_status_alone():
    ui = [
        {"kind": "navigate", "path": "/cluster?tab=overview"},
        {"kind": "click", "target": "Overview"},
        {"kind": "highlight", "action": "look", "target": "overview", "label": "cluster status", "ids": []},
    ]
    assert _coalesce_ui(ui) == ui
