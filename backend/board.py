"""Kanban boards on ``api.data``: boards, cards, locks, WIP limits and activity.

No host imports here, so the self-check runs on a plain dict. One doc per record, so
teammates editing different cards never overwrite each other:

- ``board.<bid>``: name, prefix, seq, columns ``[{id, title, wip}]``, labels
  ``[{id, name, color}]``, settings (the board's team rules)
- ``card.<bid>.<cid>``: one card (comments, checklist and attachments are ``id``'d
  arrays, so two PCs' edits merge by id)
- ``lock.<bid>.<cid>`` / ``lock.<bid>.col.<colid>``: who is working on a card or a whole
  column, and until when (``data_locks: none``: many people take and drop them)
- ``act.<bid>.<ms>-<rand>``: the board's activity feed (``data_locks: none``)

Every write names its actor: a person, or a ducky working for a person. A ducky's
change reads "Builder (Ilya's ducky)", never just "Ilya".
"""

from __future__ import annotations

import re
import time
import uuid
from typing import Any, Callable, Mapping

PRIOS = ("urgent", "high", "medium", "low")
COLORS = ("blue", "green", "red", "purple", "amber", "yellow")
DUCKY_LEASE_S = 120.0
YIELD_LEASE_S = 15.0
ACT_KEEP = 200
SETTINGS = {
    "enforceWip": True,      # refuse moves and new cards into a full column
    "agentColLocks": True,   # duckies may lock a whole column
    "agentsYield": False,    # a person opening a ducky's card releases it at once
    "agentsPaused": False,   # duckies can't change this board
    "lockTimeout": 60,       # a person's lock ends after this many idle seconds
    "allowForce": True,      # anyone may take over someone else's lock
}
CARD_FIELDS = ("title", "desc", "assignee", "labels", "priority", "due", "checklist", "attachments",
               "cover", "icon")

# name, description, columns (title, wip), labels (name, color), cards (title, column, priority, labels, checklist)
TEMPLATES: dict[str, dict[str, Any]] = {
    "blank": {"name": "Blank", "desc": "Three simple columns, no cards",
              "cols": [("To do", 0), ("In progress", 0), ("Done", 0)],
              "labels": [("Task", "blue"), ("Idea", "purple")], "cards": []},
    "sprint": {"name": "Sprint", "desc": "Backlog to Done with WIP limits",
               "cols": [("Backlog", 0), ("To do", 6), ("In progress", 3), ("Review", 3), ("Done", 0)],
               "labels": [("Frontend", "blue"), ("Backend", "green"), ("Bug", "red"), ("Design", "purple")],
               "cards": [("Set the sprint goal", 1, "high", [], ["Agree scope", "Share with team"]),
                         ("Groom the backlog", 0, "medium", [], []), ("Prepare sprint demo", 0, "low", [], []),
                         ("Retro notes", 0, "low", [], [])]},
    "bugs": {"name": "Bug tracker", "desc": "Report, triage, fix and verify",
             "cols": [("Reported", 0), ("Triaged", 0), ("Fixing", 3), ("Verifying", 0), ("Closed", 0)],
             "labels": [("Critical", "red"), ("UI", "blue"), ("API", "green"), ("Regression", "amber")],
             "cards": [("Login button unresponsive on iOS", 0, "urgent", [0, 1], []),
                       ("Export times out on large boards", 1, "high", [2], []),
                       ("Tooltip clipped in sidebar", 1, "low", [1], []),
                       ("Search ignores accents", 2, "medium", [2, 3], ["Reproduce", "Write failing test", "Fix"])]},
    "roadmap": {"name": "Roadmap", "desc": "Now, Next, Later planning",
                "cols": [("Ideas", 0), ("Now", 4), ("Next", 0), ("Later", 0), ("Shipped", 0)],
                "labels": [("Growth", "green"), ("Retention", "purple"), ("Platform", "blue")],
                "cards": [("Team workspaces", 1, "high", [0], []), ("Usage-based billing", 2, "medium", [0], []),
                          ("Offline mode", 3, "low", [2], []), ("Weekly digest email", 0, "low", [1], [])]},
    "content": {"name": "Content calendar", "desc": "Ideas through to published",
                "cols": [("Ideas", 0), ("Writing", 3), ("Editing", 0), ("Scheduled", 0), ("Published", 0)],
                "labels": [("Blog", "amber"), ("Video", "red"), ("Social", "blue"), ("Newsletter", "purple")],
                "cards": [("How we ship weekly", 1, "medium", [0], ["Outline", "Draft", "Images"]),
                          ("Product tour video", 0, "high", [1], []), ("Launch thread", 3, "medium", [2], []),
                          ("October newsletter", 2, "low", [3], [])]},
    "island": {"name": "Island build", "desc": "A UEFN island from idea to publish",
               "cols": [("Ideas", 0), ("Building", 4), ("Playtest", 3), ("Polish", 0), ("Published", 0)],
               "labels": [("Verse", "purple"), ("Devices", "blue"), ("Art", "green"), ("Bug", "red")],
               "cards": [("Core game loop", 1, "high", [0], ["Spawn", "Score", "Round end"]),
                         ("Lobby and spawn pads", 0, "medium", [1], []), ("Thumbnail and trailer", 0, "low", [2], [])]},
    "personal": {"name": "Personal week", "desc": "This week, today, done",
                 "cols": [("This week", 0), ("Today", 3), ("Done", 0)],
                 "labels": [("Work", "blue"), ("Home", "amber"), ("Health", "green")],
                 "cards": [("Plan the week", 1, "medium", [0], []), ("Groceries", 0, "low", [1], []),
                           ("Run 5 km", 0, "medium", [2], [])]},
}


class Refused(ValueError):
    """A change the board won't take (a lock, a full column, a missing card): the message
    says why, for the person or the ducky that asked."""


def slug(text: Any, limit: int = 48) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", str(text or "").strip().lower()).strip("-")[:limit].strip("-")


def uid() -> str:
    return uuid.uuid4().hex[:8]


def label(actor: Mapping[str, Any] | None) -> str:
    """Who did it, in words: "Ilya", "Builder (Ilya's ducky)", "A ducky"."""
    a = actor or {}
    name, owner = str(a.get("name") or ""), str(a.get("for") or "")
    if a.get("kind") == "ducky":
        if name and owner:
            return f"{name} ({owner}'s ducky)"
        return f"{name} (ducky)" if name else (f"{owner}'s ducky" if owner else "A ducky")
    return name or "Someone"


def same(a: Mapping[str, Any] | None, b: Mapping[str, Any] | None) -> bool:
    """The same actor: the same person, or the same ducky of the same person."""
    a, b = a or {}, b or {}
    return (a.get("kind"), a.get("user") or a.get("for") or a.get("name"), a.get("name") if a.get("kind") == "ducky" else "") == \
        (b.get("kind"), b.get("user") or b.get("for") or b.get("name"), b.get("name") if b.get("kind") == "ducky" else "")


class Boards:
    def __init__(self, data: Any, actor: Callable[[], dict[str, Any]], clock: Callable[[], float] = time.time) -> None:
        self.data, self.actor, self.clock = data, actor, clock

    # ------------------------------------------------------------------ reads

    def boards(self) -> list[dict[str, Any]]:
        out = []
        for key, b in sorted(self.data.items("board.").items()):
            if not isinstance(b, dict):
                continue
            bid = b["id"]
            cards = [c for c in self.data.items(f"card.{bid}.").values() if isinstance(c, dict)]
            counts = {c["id"]: sum(1 for x in cards if x.get("colId") == c["id"]) for c in b.get("columns", [])}
            out.append({"id": bid, "name": b.get("name", ""), "prefix": b.get("prefix", ""),
                        "columns": [{"id": c["id"], "title": c["title"], "count": counts.get(c["id"], 0)}
                                    for c in b.get("columns", [])],
                        "cards": len(cards), "updatedAt": b.get("updatedAt", 0),
                        "editing": sorted({label(lk["by"]) for lk in self._locks(bid).values()})})
        return sorted(out, key=lambda r: -float(r["updatedAt"] or 0))

    def board(self, ref: str) -> dict[str, Any]:
        ref = str(ref or "").strip()
        if not ref:
            raise Refused("Name the board (its id or name). kanban_list_boards lists them.")
        doc = self.data.get(f"board.{slug(ref)}")
        if isinstance(doc, dict):
            return doc
        for b in self.data.items("board.").values():
            if isinstance(b, dict) and str(b.get("name", "")).lower() == ref.lower():
                return b
        raise Refused(f"No board {ref!r}. kanban_list_boards lists them.")

    def view(self, ref: str) -> dict[str, Any]:
        b = self.board(ref)
        bid = b["id"]
        cols = {c["id"]: i for i, c in enumerate(b["columns"])}
        cards = sorted((c for c in self.data.items(f"card.{bid}.").values() if isinstance(c, dict)),
                       key=lambda c: (cols.get(c.get("colId"), 99), float(c.get("order", 0))))
        locks = [{**lk, "who": label(lk["by"]), "mine": same(lk["by"], self.actor())} for lk in self._locks(bid).values()]
        return {"board": b, "cards": cards, "locks": locks, "activity": self.activity(bid, 60)["items"]}

    def card(self, ref: str, card: str) -> tuple[dict[str, Any], dict[str, Any]]:
        b = self.board(ref)
        want = str(card or "").strip()
        doc = self.data.get(self._card_key(b["id"], want))
        if isinstance(doc, dict):
            return b, doc
        for c in self.data.items(f"card.{b['id']}.").values():
            if isinstance(c, dict) and str(c.get("title", "")).lower() == want.lower():
                return b, c
        raise Refused(f"No card {want!r} on {b['name']}.")

    def activity(self, ref: str, limit: int = 50) -> dict[str, Any]:
        bid = self.board(ref)["id"]
        rows = self.data.items(f"act.{bid}.")
        items = [rows[k] for k in sorted(rows, reverse=True)[:max(1, int(limit))] if isinstance(rows[k], dict)]
        return {"items": [{**a, "who": label(a.get("by"))} for a in items]}

    # ------------------------------------------------------------------ boards

    def create_board(self, name: str, template: str = "sprint") -> dict[str, Any]:
        tp = TEMPLATES.get(template or "sprint") or TEMPLATES["blank"]
        name = str(name or "").strip() or tp["name"] + (" board" if template == "blank" else "")
        bid = f"{slug(name, 24) or 'board'}-{uid()[:4]}"
        prefix = (re.sub(r"[^A-Za-z]", "", name)[:2] or "KB").upper()
        now = self.clock()
        b = {"id": bid, "name": name, "prefix": prefix, "seq": 0, "template": template,
             "columns": [{"id": f"c{i + 1}", "title": t, "wip": w} for i, (t, w) in enumerate(tp["cols"])],
             "labels": [{"id": f"l{i + 1}", "name": n, "color": c} for i, (n, c) in enumerate(tp["labels"])],
             "settings": dict(SETTINGS), "createdBy": self.actor(), "createdAt": now, "updatedAt": now}
        self.data.put(f"board.{bid}", b)
        for title, ci, prio, lbs, ck in tp["cards"]:
            self.create_card(bid, title, f"c{ci + 1}", {"priority": prio, "labels": [f"l{x + 1}" for x in lbs],
                                                        "checklist": [{"id": uid(), "text": t, "done": False} for t in ck]},
                             log=False)
        self._log(bid, f"created the board {name}")
        return self.board(bid)

    def update_board(self, ref: str, *, name: str | None = None, columns: list | None = None,
                     labels: list | None = None, settings: Mapping[str, Any] | None = None) -> dict[str, Any]:
        b = self.board(ref)
        bid = b["id"]
        if name is not None and str(name).strip():
            b["name"] = str(name).strip()
        if columns is not None:
            cols = []
            for c in columns:
                c = c if isinstance(c, dict) else {"title": str(c)}
                cols.append({"id": str(c.get("id") or f"c{uid()}"), "title": str(c.get("title") or "Column")[:60],
                             "wip": max(0, int(c.get("wip") or 0))})
            if not cols:
                raise Refused("A board needs at least one column.")
            gone = {c["id"] for c in b["columns"]} - {c["id"] for c in cols}
            for cid in gone:
                lk = self._live(self.data.get(f"lock.{bid}.col.{cid}"))
                if lk and not same(lk["by"], self.actor()):
                    raise Refused(f"Can't delete that column: {label(lk['by'])} has it locked.")
            for c in self.data.items(f"card.{bid}.").values():
                if isinstance(c, dict) and c.get("colId") in gone:
                    self._guard(b, c)
                    self.data.put(self._card_key(bid, c["id"]), {**c, "colId": cols[0]["id"]})
            b["columns"] = cols
        if labels is not None:
            b["labels"] = [{"id": str(l.get("id") or f"l{uid()}"), "name": str(l.get("name") or "Label")[:40],
                            "color": l.get("color") if l.get("color") in COLORS else COLORS[i % len(COLORS)]}
                           for i, l in enumerate(x for x in labels if isinstance(x, dict))]
        if settings:
            b["settings"] = {**SETTINGS, **b.get("settings", {}),
                             **{k: type(SETTINGS[k])(v) for k, v in settings.items() if k in SETTINGS}}
        b["updatedAt"] = self.clock()
        self.data.put(f"board.{bid}", b)
        self._log(bid, "changed the board's settings")
        return b

    def delete_board(self, ref: str) -> dict[str, Any]:
        b = self.board(ref)
        bid = b["id"]
        for lk in self._locks(bid).values():
            if not same(lk["by"], self.actor()):
                raise Refused(f"Can't delete {b['name']}: {label(lk['by'])} is working on it.")
        for prefix in (f"card.{bid}.", f"lock.{bid}.", f"act.{bid}."):
            for key in list(self.data.keys(prefix)):
                self.data.delete(key)
        self.data.delete(f"board.{bid}")
        return {"id": bid, "name": b["name"]}

    # ------------------------------------------------------------------ cards

    def create_card(self, ref: str, title: str, column: str = "", fields: Mapping[str, Any] | None = None,
                    *, log: bool = True) -> dict[str, Any]:
        b = self.board(ref)
        title = str(title or "").strip()
        if not title:
            raise Refused("Give the card a title.")
        col = self._column(b, column) if column else b["columns"][0]
        self._column_open(b, col, None)
        b["seq"] = int(b.get("seq", 0)) + 1
        cid = f"{b['prefix']}-{100 + b['seq']}"
        me, now = self.actor(), self.clock()
        card = {"id": cid, "board": b["id"], "colId": col["id"], "order": self._end(b["id"], col["id"]),
                "title": title, "name": title, "desc": "", "assignee": None, "labels": [], "priority": "medium",
                "due": "", "checklist": [], "comments": [], "attachments": [], "cover": "", "icon": "",
                "createdAt": now, "createdBy": me, "updatedAt": now, "updatedBy": me}
        card.update(self._clean(b, fields or {}))
        b["updatedAt"] = now
        self.data.put(f"board.{b['id']}", b)
        self.data.put(self._card_key(b["id"], cid), card)
        if log:
            self._log(b["id"], f"created “{title}” in {col['title']}")
        return card

    def update_card(self, ref: str, card: str, fields: Mapping[str, Any]) -> dict[str, Any]:
        b, c = self.card(ref, card)
        self._guard(b, c)
        patch = self._clean(b, fields or {})
        if not patch:
            raise Refused(f"Nothing to change. Fields: {', '.join(CARD_FIELDS)}.")
        c = {**c, **patch, "updatedAt": self.clock(), "updatedBy": self.actor()}
        if "title" in patch:
            c["name"] = c["title"]
        self.data.put(self._card_key(b["id"], c["id"]), c)
        self._hold(b, c)
        what = "updated" if set(patch) - {"checklist"} else "updated the checklist on"
        self._log(b["id"], f"{what} “{c['title']}”")
        return c

    def move_card(self, ref: str, card: str, column: str, before: str = "") -> dict[str, Any]:
        b, c = self.card(ref, card)
        col = self._column(b, column)
        self._guard(b, c)
        moved = c["colId"] != col["id"]
        if moved:
            self._column_open(b, col, c)
        c = {**c, "colId": col["id"], "order": self._order_before(b["id"], col["id"], before, c["id"]),
             "updatedAt": self.clock(), "updatedBy": self.actor()}
        self.data.put(self._card_key(b["id"], c["id"]), c)
        self._hold(b, c)
        if moved:
            self._log(b["id"], f"moved “{c['title']}” to {col['title']}")
        return c

    def delete_card(self, ref: str, card: str) -> dict[str, Any]:
        b, c = self.card(ref, card)
        self._guard(b, c)
        self.data.delete(self._card_key(b["id"], c["id"]))
        self.data.delete(f"lock.{b['id']}.{slug(c['id'])}")
        self._log(b["id"], f"deleted “{c['title']}”")
        return c

    def restore_card(self, ref: str, card: Mapping[str, Any]) -> dict[str, Any]:
        """Put a card back as it was (Revert in Changes)."""
        b = self.board(ref)
        if not isinstance(card, Mapping) or not card.get("id"):
            raise Refused("Give the card as it was.")
        old = self.data.get(self._card_key(b["id"], card["id"]))
        if isinstance(old, dict):
            self._guard(b, old)
        doc = {**dict(card), "board": b["id"], "updatedAt": self.clock(), "updatedBy": self.actor()}
        self.data.put(self._card_key(b["id"], doc["id"]), doc)
        self._log(b["id"], f"restored “{doc.get('title', doc['id'])}”")
        return doc

    def comment(self, ref: str, card: str, text: str) -> dict[str, Any]:
        """Comments stay open on locked cards."""
        b, c = self.card(ref, card)
        text = str(text or "").strip()
        if not text:
            raise Refused("Write the comment.")
        row = {"id": uid(), "by": self.actor(), "text": text[:4000], "at": self.clock()}
        c = {**c, "comments": [*c.get("comments", []), row]}
        self.data.put(self._card_key(b["id"], c["id"]), c)
        self._log(b["id"], f"commented on “{c['title']}”")
        return row

    # ------------------------------------------------------------------ locks

    def lock(self, ref: str, card: str = "", column: str = "", task: str = "", minutes: float = 0) -> dict[str, Any]:
        """Lock a card (or, for a ducky, a whole column) while working on it."""
        b = self.board(ref)
        me, now = self.actor(), self.clock()
        if column:
            col = self._column(b, column)
            if me.get("kind") == "ducky" and not b["settings"].get("agentColLocks", True):
                raise Refused(f"Duckies can't lock whole columns on {b['name']} (its settings say so).")
            key, name = f"lock.{b['id']}.col.{col['id']}", col["title"]
            for c in self.data.items(f"card.{b['id']}.").values():
                if isinstance(c, dict) and c.get("colId") == col["id"]:
                    held = self._live(self.data.get(self._lock_key(b, c)))
                    if held and not same(held["by"], me):
                        raise Refused(f"Can't lock {name}: {label(held['by'])} is working on “{c['title']}”.")
        else:
            b, c = self.card(ref, card)
            self._guard(b, c)
            key, name = self._lock_key(b, c), c["title"]
        held = self._live(self.data.get(key))
        if held and not same(held["by"], me):
            raise Refused(f"{name} is locked by {label(held['by'])}{self._task(held)}.")
        if me.get("kind") == "ducky" and b["settings"].get("agentsPaused"):
            raise Refused(f"Duckies are paused on {b['name']}.")
        lease = float(minutes) * 60 if minutes else (DUCKY_LEASE_S if me.get("kind") == "ducky"
                                                     else float(b["settings"].get("lockTimeout", 60)))
        doc = {"by": me, "task": str(task or "")[:80], "name": name, "since": (held or {}).get("since", now),
               "touched": now, "lease": lease, "column": bool(column)}
        self.data.put(key, doc)
        if column and not held:
            self._log(b["id"], f"locked the {name} column{self._task(doc)}")
        return {**doc, "key": key, "who": label(me)}

    def unlock(self, ref: str, card: str = "", column: str = "") -> dict[str, Any]:
        b = self.board(ref)
        key = f"lock.{b['id']}.col.{self._column(b, column)['id']}" if column else self._lock_key(b, self.card(ref, card)[1])
        held = self._live(self.data.get(key))
        if held and not same(held["by"], self.actor()):
            raise Refused(f"{held.get('name') or 'That'} is locked by {label(held['by'])}, not you. "
                          "Ask them to yield, or force unlock.")
        self.data.delete(key)
        return {"released": bool(held)}

    def ask_yield(self, ref: str, card: str) -> dict[str, Any]:
        """Ask whoever holds a card (or its column) to let go. A ducky lets go within
        seconds, at once when the board says duckies yield to people."""
        b, c = self.card(ref, card)
        me, now = self.actor(), self.clock()
        for key in (f"lock.{b['id']}.col.{c['colId']}", self._lock_key(b, c)):
            held = self._live(self.data.get(key))
            if not held or same(held["by"], me):
                continue
            if held["by"].get("kind") == "ducky" and b["settings"].get("agentsYield"):
                self.data.delete(key)
                self._log(b["id"], f"asked {label(held['by'])} to yield “{held['name']}”, and it did")
                return {"released": True, "who": label(held["by"])}
            ducky = held["by"].get("kind") == "ducky"
            self.data.put(key, {**held, "yieldAsked": {"by": me, "at": now},
                                "lease": min(held["lease"], (now - held["touched"]) + YIELD_LEASE_S) if ducky
                                else held["lease"]})
            self._log(b["id"], f"asked {label(held['by'])} to finish up “{held['name']}”")
            return {"released": False, "asked": True, "who": label(held["by"])}
        return {"released": True}

    def force_unlock(self, ref: str, card: str) -> dict[str, Any]:
        b, c = self.card(ref, card)
        if not b["settings"].get("allowForce", True):
            raise Refused(f"Force unlock is off on {b['name']}.")
        took = []
        for key in (f"lock.{b['id']}.col.{c['colId']}", self._lock_key(b, c)):
            held = self._live(self.data.get(key))
            if held and not same(held["by"], self.actor()):
                self.data.delete(key)
                took.append(label(held["by"]))
        if took:
            self._log(b["id"], f"force-unlocked “{c['title']}” from {', '.join(took)}")
        return {**self.lock(b["id"], c["id"]), "from": took}

    # ------------------------------------------------------------------ helpers

    def _card_key(self, bid: str, cid: str) -> str:
        return f"card.{bid}.{slug(cid)}"

    def _lock_key(self, b: Mapping[str, Any], c: Mapping[str, Any]) -> str:
        return f"lock.{b['id']}.{slug(c['id'])}"

    def _live(self, lk: Any) -> dict[str, Any] | None:
        if not isinstance(lk, dict) or not isinstance(lk.get("by"), dict):
            return None
        return lk if self.clock() - float(lk.get("touched", 0)) < float(lk.get("lease", 0)) else None

    def _locks(self, bid: str) -> dict[str, dict[str, Any]]:
        out = {}
        for key, lk in self.data.items(f"lock.{bid}.").items():
            live = self._live(lk)
            if live:
                out[key] = {**live, "key": key, "card": "" if live.get("column") else key.rsplit(".", 1)[-1],
                            "colId": key.rsplit(".", 1)[-1] if live.get("column") else ""}
        return out

    @staticmethod
    def _task(lk: Mapping[str, Any]) -> str:
        return f" · {lk['task']}" if lk.get("task") else ""

    def _guard(self, b: Mapping[str, Any], c: Mapping[str, Any]) -> None:
        """Refuse a change while someone else holds the card or its column."""
        me = self.actor()
        if me.get("kind") == "ducky" and b["settings"].get("agentsPaused"):
            raise Refused(f"Duckies are paused on {b['name']}. Your change wasn't saved.")
        col = self._live(self.data.get(f"lock.{b['id']}.col.{c.get('colId')}"))
        if col and not same(col["by"], me):
            raise Refused(f"{col['name']} is locked by {label(col['by'])}{self._task(col)}. "
                          "Your change wasn't saved.")
        held = self._live(self.data.get(self._lock_key(b, c)))
        if held and not same(held["by"], me):
            asked = " They were asked to finish up." if held.get("yieldAsked") else ""
            raise Refused(f"“{c.get('title')}” is locked by {label(held['by'])}{self._task(held)}.{asked} "
                          "Your change wasn't saved.")

    def _hold(self, b: Mapping[str, Any], c: Mapping[str, Any]) -> None:
        """A ducky's change holds the card for a while, so people see who is on it; a
        person's change keeps the lock they already have from going idle."""
        me, key = self.actor(), self._lock_key(b, c)
        held = self._live(self.data.get(key))
        if held:
            if same(held["by"], me) and not held.get("yieldAsked"):
                self.data.put(key, {**held, "touched": self.clock()})
            return
        if me.get("kind") == "ducky":
            self.data.put(key, {"by": me, "task": "Editing", "name": c["title"], "since": self.clock(),
                                "touched": self.clock(), "lease": DUCKY_LEASE_S, "column": False})

    def _column(self, b: Mapping[str, Any], ref: str) -> dict[str, Any]:
        want = str(ref or "").strip().lower()
        for c in b["columns"]:
            if c["id"].lower() == want or c["title"].lower() == want:
                return c
        raise Refused(f"No column {ref!r} on {b['name']}. Columns: {', '.join(c['title'] for c in b['columns'])}.")

    def _column_open(self, b: Mapping[str, Any], col: Mapping[str, Any], card: Mapping[str, Any] | None) -> None:
        held = self._live(self.data.get(f"lock.{b['id']}.col.{col['id']}"))
        if held and not same(held["by"], self.actor()):
            raise Refused(f"{col['title']} is locked by {label(held['by'])}{self._task(held)}.")
        if not b["settings"].get("enforceWip", True) or not col.get("wip"):
            return
        n = sum(1 for c in self.data.items(f"card.{b['id']}.").values()
                if isinstance(c, dict) and c.get("colId") == col["id"] and (card is None or c["id"] != card["id"]))
        if n >= int(col["wip"]):
            raise Refused(f"{col['title']} is at its WIP limit ({col['wip']}).")

    def _orders(self, bid: str, colid: str, skip: str = "") -> list[tuple[float, str]]:
        return sorted((float(c.get("order", 0)), c["id"]) for c in self.data.items(f"card.{bid}.").values()
                      if isinstance(c, dict) and c.get("colId") == colid and c["id"] != skip)

    def _end(self, bid: str, colid: str) -> float:
        rows = self._orders(bid, colid)
        return (rows[-1][0] + 1.0) if rows else 1.0

    def _order_before(self, bid: str, colid: str, before: str, skip: str) -> float:
        rows = self._orders(bid, colid, skip)
        for i, (order, cid) in enumerate(rows):
            if before and cid.lower() == str(before).lower():
                prev = rows[i - 1][0] if i else order - 1.0
                return (prev + order) / 2
        return (rows[-1][0] + 1.0) if rows else 1.0

    def _clean(self, b: Mapping[str, Any], fields: Mapping[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        labels = {l["id"]: l for l in b["labels"]}
        by_name = {l["name"].lower(): l["id"] for l in b["labels"]}
        for k, v in fields.items():
            if k not in CARD_FIELDS:
                continue
            if k == "title":
                if str(v or "").strip():
                    out[k] = str(v).strip()[:200]
            elif k == "priority":
                if v not in PRIOS:
                    raise Refused(f"Priority is one of {', '.join(PRIOS)}.")
                out[k] = v
            elif k == "labels":
                ids = [x if x in labels else by_name.get(str(x).lower(), "") for x in (v or [])]
                out[k] = [x for x in dict.fromkeys(ids) if x]
            elif k == "assignee":
                out[k] = ({"kind": "ducky" if v.get("kind") == "ducky" else "person", "name": str(v.get("name") or "")[:60],
                           **({"for": str(v["for"])[:60]} if v.get("for") else {})}
                          if isinstance(v, dict) and v.get("name") else None)
            elif k == "checklist":
                out[k] = [{"id": str(i.get("id") or uid()), "text": str(i.get("text") or "")[:200], "done": bool(i.get("done"))}
                          for i in (v or []) if isinstance(i, dict)]
            elif k == "attachments":
                out[k] = [dict(a, id=str(a.get("id") or uid())) for a in (v or []) if isinstance(a, dict)]
            elif k == "due":
                if v and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(v)):
                    raise Refused("Due date is YYYY-MM-DD.")
                out[k] = str(v or "")
            else:
                out[k] = str(v or "")[:20000 if k == "desc" else 400]
        return out

    def _log(self, bid: str, text: str) -> None:
        now = self.clock()
        self.data.put(f"act.{bid}.{int(now * 1000):014d}-{uid()[:4]}", {"by": self.actor(), "text": text, "at": now})
        keys = sorted(self.data.keys(f"act.{bid}."))
        for key in keys[:-ACT_KEEP]:
            self.data.delete(key)
