from types import SimpleNamespace
from unittest.mock import patch

from app.agent import _collect_calls, _leaked_calls, _run_chat, _strip_leaked
from app.models import Role as ModelRole


DUMP = """highlight_ui
target="overview"
label="cluster health"
action="look"
"""


def test_parse_kv_dump():
    calls = _leaked_calls(DUMP)
    assert len(calls) == 1
    assert calls[0]["name"] == "highlight_ui"
    assert calls[0]["arguments"]["target"] == "overview"
    assert calls[0]["arguments"]["label"] == "cluster health"
    assert calls[0]["arguments"]["action"] == "look"


def test_strip_leaves_spoken_words():
    mixed = "Cluster health is on Overview.\n\n" + DUMP
    assert "highlight_ui" not in _strip_leaked(mixed)
    assert "Cluster health is on Overview." in _strip_leaked(mixed)
    assert _strip_leaked(DUMP) == ""


def test_xml_dump():
    raw = '<highlight_ui target="health" label="sniffing" action="look"/>'
    calls = _leaked_calls(raw)
    assert calls[0]["name"] == "highlight_ui"
    assert calls[0]["arguments"]["target"] == "health"
    assert _strip_leaked(raw) == ""


def test_collect_prefers_native_calls():
    resp = {
        "output_text": DUMP,
        "output": [
            {"type": "function_call", "name": "get_health", "arguments": "{}", "call_id": "1"},
            {"type": "message", "content": [{"type": "output_text", "text": DUMP}]},
        ],
    }
    calls, leaked = _collect_calls(resp)
    assert leaked is False
    assert calls[0]["name"] == "get_health"


def test_collect_leaked_when_no_native():
    resp = {
        "output_text": DUMP,
        "output": [{"type": "message", "content": [{"type": "output_text", "text": DUMP}]}],
    }
    calls, leaked = _collect_calls(resp)
    assert leaked is True
    assert calls[0]["name"] == "highlight_ui"
    assert "overview" in calls[0]["arguments"]


def test_run_chat_executes_leaked_highlight():
    dump_resp = {
        "id": "r1",
        "output_text": DUMP,
        "output": [{"type": "message", "content": [{"type": "output_text", "text": DUMP}]}],
    }
    spoken = {
        "id": "r2",
        "output_text": "Cluster health is on Overview. Leave it to me.",
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": "Cluster health is on Overview. Leave it to me."}],
            }
        ],
    }
    queue = [dump_resp, spoken]
    user = SimpleNamespace(id="u", role=ModelRole.ADMIN)
    with (
        patch("app.agent.current_key", lambda db: "fake-key"),
        patch("app.agent._brief_cluster", lambda db: ""),
        patch("app.agent.tool_list_sops", lambda db: {"docs": []}),
        patch("app.agent._fallback_choices", lambda db, actions=None: []),
        patch("app.agent._xai_post", lambda payload, key: queue.pop(0)),
    ):
        out = _run_chat(None, user, [{"role": "user", "content": "show cluster health"}])
    assert "highlight_ui" not in out["reply"]
    assert "Overview" in out["reply"]
    assert any(a["name"] == "highlight_ui" and a["ok"] for a in out["actions"])
    kinds = [u.get("kind") for u in out["ui"]]
    assert "highlight" in kinds
    assert any(u.get("target") == "overview" for u in out["ui"])


if __name__ == "__main__":
    test_parse_kv_dump()
    test_strip_leaves_spoken_words()
    test_xml_dump()
    test_collect_prefers_native_calls()
    test_collect_leaked_when_no_native()
    test_run_chat_executes_leaked_highlight()
    print("ok")
