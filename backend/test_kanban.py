"""Self-check for the board engine: no host, a dict stands in for ``api.data``.

py -m pytest -q --import-mode=importlib backend/test_kanban.py
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("kanban_board", Path(__file__).with_name("board.py"))
board = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(board)  # type: ignore[union-attr]

ILYA = {"kind": "person", "name": "Ilya", "user": "u_ilya"}
ANA = {"kind": "person", "name": "Ana", "user": "u_ana"}
BUILDER = {"kind": "ducky", "name": "Builder", "for": "Ilya", "user": "u_ilya"}


class Data:
    def __init__(self) -> None:
        self.docs: dict = {}

    def get(self, key, default=None):
        return self.docs.get(key, default)

    def put(self, key, value):
        self.docs[key] = value

    def delete(self, key):
        self.docs.pop(key, None)

    def items(self, prefix=""):
        return {k: v for k, v in self.docs.items() if k.startswith(prefix)}

    def keys(self, prefix=""):
        return [k for k in self.docs if k.startswith(prefix)]


class World:
    def __init__(self) -> None:
        self.data, self.who, self.t = Data(), ILYA, 1000.0

    def as_(self, who):
        self.who = who
        return board.Boards(self.data, lambda: dict(self.who), clock=lambda: self.t)


@pytest.fixture
def w() -> World:
    return World()


def test_labels_name_the_ducky_and_its_person() -> None:
    assert board.label(BUILDER) == "Builder (Ilya's ducky)"
    assert board.label({"kind": "ducky", "name": "", "for": "Ilya"}) == "Ilya's ducky"
    assert board.label(ILYA) == "Ilya"
    assert not board.same(BUILDER, ILYA)  # a ducky is never its person


def test_create_edit_move_delete_and_read_back(w: World) -> None:
    kb = w.as_(ILYA)
    b = kb.create_board("Product Sprint", "sprint")
    assert [c["title"] for c in b["columns"]] == ["Backlog", "To do", "In progress", "Review", "Done"]
    assert len(kb.view(b["id"])["cards"]) == 4  # the template's cards
    card = kb.create_card(b["id"], "Fix timezone offset", "Backlog", {"priority": "urgent", "labels": ["Bug"]})
    assert card["id"] == "PR-105" and card["labels"] == ["l3"]
    kb.update_card(b["id"], card["id"], {"desc": "Shifts by a day", "checklist": [{"text": "Reproduce"}]})
    kb.move_card(b["id"], card["id"], "In progress")
    again = kb.card(b["name"], "pr-105")[1]  # by board name, card id in any case
    assert (again["colId"], again["desc"], again["checklist"][0]["text"]) == ("c3", "Shifts by a day", "Reproduce")
    kb.delete_card(b["id"], card["id"])
    with pytest.raises(board.Refused):
        kb.card(b["id"], card["id"])


def test_boards_list_for_ducky_references(w: World) -> None:
    kb = w.as_(ILYA)
    b = kb.create_board("Product Sprint", "sprint")
    rows = kb.reference_rows()
    assert rows == [{"id": b["id"], "label": "Product Sprint", "description": "4 cards · 4 open"}]
    assert all(ch.isalnum() or ch in "_.-" for ch in rows[0]["id"])  # fits in a plugin:kanban/board:<id> link


def test_wip_limit_refuses_a_full_column(w: World) -> None:
    kb = w.as_(ILYA)
    b = kb.create_board("Bugs", "bugs")  # Fixing: WIP 3, holds 1
    for i in range(2):
        kb.create_card(b["id"], f"Bug {i}", "Fixing")
    with pytest.raises(board.Refused, match="WIP limit"):
        kb.create_card(b["id"], "One too many", "Fixing")
    loose = kb.create_card(b["id"], "Loose", "Reported")
    with pytest.raises(board.Refused, match="WIP limit"):
        kb.move_card(b["id"], loose["id"], "Fixing")
    kb.update_board(b["id"], settings={"enforceWip": False})
    assert kb.move_card(b["id"], loose["id"], "Fixing")["colId"] == "c3"


def test_a_duckys_edit_holds_the_card_and_others_are_refused(w: World) -> None:
    b = w.as_(ILYA).create_board("Island", "blank")
    card = w.as_(ILYA).create_card(b["id"], "Spawn pads")
    w.as_(BUILDER).update_card(b["id"], card["id"], {"desc": "Four pads"})
    lock = w.as_(ILYA).view(b["id"])["locks"][0]
    assert lock["who"] == "Builder (Ilya's ducky)" and not lock["mine"]  # Ilya is not his ducky
    with pytest.raises(board.Refused, match=r"locked by Builder \(Ilya's ducky\)"):
        w.as_(ILYA).update_card(b["id"], card["id"], {"desc": "mine"})
    w.as_(ILYA).comment(b["id"], card["id"], "Comments still work")  # open on locked cards
    w.t += board.DUCKY_LEASE_S + 1  # the ducky went quiet: its hold runs out
    assert w.as_(ILYA).update_card(b["id"], card["id"], {"desc": "mine"})["desc"] == "mine"
    act = w.as_(ILYA).activity(b["id"])["items"]
    assert any(a["who"] == "Builder (Ilya's ducky)" and "updated" in a["text"] for a in act)


def test_person_lock_idles_out_yield_and_force(w: World) -> None:
    b = w.as_(ANA).create_board("Ops", "blank")
    card = w.as_(ANA).create_card(b["id"], "Rotate certs")
    w.as_(ANA).lock(b["id"], card["id"])
    with pytest.raises(board.Refused, match="locked by Ana"):
        w.as_(ILYA).move_card(b["id"], card["id"], "Done")
    assert w.as_(ILYA).ask_yield(b["id"], card["id"])["asked"]
    with pytest.raises(board.Refused, match="asked to finish up"):
        w.as_(ILYA).update_card(b["id"], card["id"], {"desc": "x"})
    took = w.as_(ILYA).force_unlock(b["id"], card["id"])
    assert took["from"] == ["Ana"] and took["who"] == "Ilya"
    w.as_(ANA)
    w.t += 61  # Ilya's lock idles out after the board's 60 s
    assert w.as_(ANA).update_card(b["id"], card["id"], {"desc": "back"})["desc"] == "back"
    w.as_(ILYA).update_board(b["id"], settings={"allowForce": False})
    w.as_(ANA).lock(b["id"], card["id"])
    with pytest.raises(board.Refused, match="Force unlock is off"):
        w.as_(ILYA).force_unlock(b["id"], card["id"])


def test_ducky_column_lock_yield_and_pause(w: World) -> None:
    b = w.as_(ILYA).create_board("Sprint", "sprint")
    w.as_(BUILDER).lock(b["id"], column="Backlog", task="Sorting by priority")
    backlog = [c for c in w.as_(ILYA).view(b["id"])["cards"] if c["colId"] == "c1"][0]
    with pytest.raises(board.Refused, match="Backlog is locked by Builder"):
        w.as_(ILYA).update_card(b["id"], backlog["id"], {"desc": "x"})
    w.as_(ILYA).update_board(b["id"], settings={"agentsYield": True})
    assert w.as_(ILYA).ask_yield(b["id"], backlog["id"])["released"]
    w.as_(ILYA).update_board(b["id"], settings={"agentsPaused": True})
    with pytest.raises(board.Refused, match="paused"):
        w.as_(BUILDER).update_card(b["id"], backlog["id"], {"desc": "x"})
    w.as_(ILYA).update_board(b["id"], settings={"agentColLocks": False, "agentsPaused": False})
    with pytest.raises(board.Refused, match="can't lock whole columns"):
        w.as_(BUILDER).lock(b["id"], column="Backlog")


def test_drop_order_and_column_delete_moves_cards(w: World) -> None:
    kb = w.as_(ILYA)
    b = kb.create_board("Order", "blank")
    one, two = kb.create_card(b["id"], "One"), kb.create_card(b["id"], "Two")
    kb.move_card(b["id"], two["id"], "To do", before=one["id"])
    assert [c["title"] for c in kb.view(b["id"])["cards"]] == ["Two", "One"]
    kb.move_card(b["id"], one["id"], "Done")
    kb.update_board(b["id"], columns=[c for c in b["columns"] if c["title"] != "Done"])
    assert {c["colId"] for c in kb.view(b["id"])["cards"]} == {"c1"}


def test_bad_input_is_refused_with_a_reason(w: World) -> None:
    kb = w.as_(ILYA)
    b = kb.create_board("X", "blank")
    with pytest.raises(board.Refused, match="Priority"):
        kb.create_card(b["id"], "Bad", fields={"priority": "asap"})
    with pytest.raises(board.Refused, match="No column"):
        kb.create_card(b["id"], "Bad", "Nowhere")
    with pytest.raises(board.Refused, match="No board"):
        kb.view("missing")
    assert len(kb.boards()) == 1 and kb.delete_board(b["id"])["name"] == "X" and not kb.boards()


def test_an_edit_saved_as_it_is_typed_is_one_activity_entry(w: World) -> None:
    b = w.as_(ILYA).create_board("Ops", "blank")
    card = w.as_(ILYA).create_card(b["id"], "Spawn pads")
    for text in ("F", "Fou", "Four pads"):  # saved at each pause while typing
        w.t += 2
        w.as_(ILYA).update_card(b["id"], card["id"], {"desc": text})
    updated = lambda: [a for a in w.as_(ILYA).activity(b["id"])["items"] if a["text"].startswith("updated")]  # noqa: E731
    assert len(updated()) == 1 and updated()[0]["at"] == w.t
    w.t += board.ACT_MERGE_S + 1  # a later edit is its own entry
    w.as_(ILYA).update_card(b["id"], card["id"], {"desc": "Four pads, lit"})
    assert len(updated()) == 2
