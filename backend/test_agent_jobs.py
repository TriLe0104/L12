from app.agent_jobs import _briefing, _mission, _review_fallback, _voice_status


def test_voice_check_names():
    assert _voice_status("N1: fw") == "Checking N1 firmware."
    assert _voice_status("GB300-01: bom") == "Checking GB300-01 BOM."


def test_voice_station():
    assert _voice_status("waiting on dcgm-diag").startswith("Still on station.")
    assert _voice_status("starting sanity on GB300-01").startswith("On it.")


def test_mission_and_briefing():
    mission = _mission("sanity", None, "GB300-01")
    assert mission == "L11 sanity on GB300-01"
    brief = _briefing("Scratch", mission)
    assert "Scratch" in brief
    assert "L11 sanity" in brief


def test_review_ok():
    text = _review_fallback(
        {"minion": "Scratch", "mission": "L11 sanity", "status": "done", "ok": True, "doing": "clean"},
        "",
    )
    assert "Scratch" in text
    assert "back" in text.lower() or "clean" in text.lower()


def test_review_fail():
    text = _review_fallback(
        {
            "minion": "Whisk",
            "mission": "Argus dcgm-diag",
            "status": "failed",
            "ok": False,
            "error": "timeout",
        },
        "",
    )
    assert "Whisk" in text
    assert "timeout" in text or "failed" in text.lower()


def test_review_recalled():
    text = _review_fallback(
        {"minion": "Paw", "mission": "L11 sanity", "status": "stopped", "ok": False},
        "",
    )
    assert "Paw" in text
    assert "pulled" in text.lower()
