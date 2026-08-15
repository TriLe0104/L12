"""Unit tests for per-part traveler drafts. Run from backend/:
  python test_part_drafts.py
"""

from app.traveler import (
    compose_saved_draft,
    draft_overrides,
    part_draft,
    read_part_drafts,
    set_part_draft,
)


class FakePO:
    def __init__(self, draft=None):
        self.traveler_draft = draft


def test_legacy_flat_maps_to_part_zero():
    drafts = read_part_drafts({"part_number": "A", "qty": 2})
    assert drafts == {0: {"part_number": "A", "qty": 2}}


def test_keyed_maps_stay_per_part():
    drafts = read_part_drafts({"0": {"part_number": "A"}, "1": {"part_number": "B"}})
    assert drafts[0]["part_number"] == "A"
    assert drafts[1]["part_number"] == "B"


def test_set_part_draft_does_not_clobber_sibling():
    po = FakePO({"part_number": "A", "notes": "first"})
    set_part_draft(po, 1, {"part_number": "B", "notes": "second"})
    assert part_draft(po, 0)["part_number"] == "A"
    assert part_draft(po, 1)["part_number"] == "B"
    assert part_draft(po, 1)["notes"] == "second"


def test_legacy_draft_follows_card():
    detached, values = draft_overrides({"certificates": "old", "programmer": "Pat"})
    assert detached == []
    assert values["certificates"] == "old"
    assert values["programmer"] == "Pat"


def test_compose_keeps_only_overrides():
    stored = compose_saved_draft(
        {
            "certificates": "MAT CERT",
            "material": "6061",
            "programmer": "Alex",
            "part_number": "X",
        },
        ["certificates"],
    )
    assert stored["detached"] == ["certificates"]
    assert stored["certificates"] == "MAT CERT"
    assert stored["programmer"] == "Alex"
    assert "material" not in stored
    assert "part_number" not in stored
    detached, values = draft_overrides(stored)
    assert detached == ["certificates"]
    assert values["certificates"] == "MAT CERT"


def main() -> None:
    test_legacy_flat_maps_to_part_zero()
    test_keyed_maps_stay_per_part()
    test_set_part_draft_does_not_clobber_sibling()
    test_legacy_draft_follows_card()
    test_compose_keeps_only_overrides()
    print("OK part drafts")


if __name__ == "__main__":
    main()
