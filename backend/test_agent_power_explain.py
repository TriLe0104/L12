from app.agent import DYNAMIC_POWER_ATTRS, _match_power_attrs, tool_explain_dynamic_power


def test_dynamic_power_guide_covers_the_page():
    names = {row["name"] for row in DYNAMIC_POWER_ATTRS}
    for label in (
        "GPU cap left",
        "GPU Power Budget",
        "GPU Load %",
        "Operation Range",
        "Ramp up",
        "Ramp down",
        "Continuous",
        "Frequency",
        "Total available power",
        "Run on",
        "Processes",
    ):
        assert label in names


def test_explain_dynamic_power_filters_and_includes_live_settings():
    one = tool_explain_dynamic_power(topic="gpu cap left")
    assert one["ok"] is True
    assert [row["name"] for row in one["attributes"]] == ["GPU cap left"]
    assert "BMC max" in one["attributes"][0]["says"]
    assert one["ui"][0]["path"] == "/maxlps"
    live = one["live"]
    for key in ("gpu_load_pct", "operation_range_points", "ramp_up_x", "gpu_power_budget_pct", "frequency_ms"):
        assert key in live

    ramps = _match_power_attrs("how do the ramps work")
    assert {row["name"] for row in ramps} >= {"Ramp up", "Ramp down"}

    page = tool_explain_dynamic_power(topic="")
    assert len(page["attributes"]) == len(DYNAMIC_POWER_ATTRS)
