"""Unit tests for per-part traveler drafts. Run from backend/:
  python test_part_drafts.py
"""

from app.traveler import part_draft, read_part_drafts, set_part_draft


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


def main() -> None:
    test_legacy_flat_maps_to_part_zero()
    test_keyed_maps_stay_per_part()
    test_set_part_draft_does_not_clobber_sibling()
    print("OK part drafts")


if __name__ == "__main__":
    main()
