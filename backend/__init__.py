"""Kanban: boards for people and duckies, with live team sync, locks and MCP tools.

Every action is one function in :mod:`.board`, reached three ways: an MCP tool
(``kanban_*``), a panel RPC and a workflow node. Who did it comes from the host: a
tool call inside a ducky's run is that ducky's, working for its person.
"""

from __future__ import annotations

import base64
import re
import time
from typing import Any, Callable

from .board import COLORS, PRIOS, SETTINGS, TEMPLATES, Boards, Refused, label, slug

INTENT = r"\b(kanban|boards?|cards?|backlog|sprint|wip limit|to-?do list)\b"
MAX_ATTACH = 15 * 1024 * 1024
VIEW_DEFAULTS = {"kanban_density": "compact", "kanban_show_labels": True, "kanban_show_priority": True,
                 "kanban_show_due": True, "kanban_show_checklist": True, "kanban_show_comments": True,
                 "kanban_show_assignee": True, "kanban_show_desc": False}


def register(api) -> None:
    data = api.data
    pid = api.plugin_id
    me_cache: dict[str, Any] = {"at": float("-inf"), "name": "", "user": ""}

    def me() -> tuple[str, str]:
        """The signed-in person's display name and id (cached 30 s)."""
        if time.monotonic() - me_cache["at"] > 30:
            try:
                from frontend.duckyos_account import get_status

                st = get_status()
                me_cache.update(name=str(st.get("display_name") or ""), user=str(st.get("user_id") or ""))
            except Exception:  # noqa: BLE001 — a board still works signed out
                pass
            me_cache["at"] = time.monotonic()
        return me_cache["name"], me_cache["user"]

    def actor() -> dict[str, Any]:
        """A ducky's call is the ducky's (for its person), never the person's own."""
        try:
            from backend.uefn_plugins.scopes import caller

            kind, ducky = caller()
        except Exception:  # noqa: BLE001
            kind, ducky = "user", ""
        name, user = me()
        if kind == "agent":
            # "for" is stored in shared data: never "you", which reads wrong on a teammate's PC.
            return {"kind": "ducky", "name": ducky, "for": name, "user": user}
        return {"kind": "person", "name": name or "You", "user": user}

    kb = Boards(data, actor)

    def push(board_id: str = "") -> None:
        try:
            from frontend.ui_web.verse_editor.panel_events import push_agent_event

            push_agent_event({"type": "kanban_changed", "plugin_id": pid, "board": board_id})
        except Exception:  # noqa: BLE001 — the panel also reloads on sync
            pass

    def record(command: str, board_id: str, card_id: str, before: Any, inverse: list) -> None:
        api.changeset.record(command=command, kind="card", ident=f"{board_id}/{card_id}", facet="record",
                             before=before, inverse=inverse, slot=f"{pid}://card/{board_id}.{card_id}/record")

    def run(fn: Callable[[], Any], board_id: str = "", key: str = "item") -> dict[str, Any]:
        try:
            out = fn()
        except (Refused, PermissionError) as exc:  # a lock, a full column, a read-only team copy
            return {"ok": False, "error": str(exc)}
        push(board_id)
        return {"ok": True, **(out if isinstance(out, dict) and key == "" else {key: out})}

    def board_id(ref: str) -> str:
        try:
            return kb.board(ref)["id"]
        except Refused:
            return ""

    # ------------------------------------------------------------------ actions

    def list_boards() -> dict[str, Any]:
        return {"ok": True, "boards": kb.boards(), "templates": templates()["templates"]}

    def get_board(board: str) -> dict[str, Any]:
        try:
            v = kb.view(board)
        except Refused as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, **v, "me": label(actor())}

    def templates() -> dict[str, Any]:
        return {"ok": True, "templates": [{"id": k, "name": t["name"], "desc": t["desc"],
                                           "columns": [{"title": c, "wip": w} for c, w in t["cols"]],
                                           "cards": [c[1] for c in t["cards"]]} for k, t in TEMPLATES.items()]}

    def create_board(name: str = "", template: str = "sprint") -> dict[str, Any]:
        out = run(lambda: kb.create_board(name, template), key="board")
        if out["ok"]:
            bid = out["board"]["id"]
            api.changeset.record(command="kanban_create_board", kind="board", ident=bid, facet="record", before=None,
                                 inverse=[{"command": "kanban_delete_board", "params": {"board": bid}}],
                                 slot=f"{pid}://board/{bid}/record")
        return out

    def update_board(board: str, name: str | None = None, columns: list | None = None, labels: list | None = None,
                     settings: dict | None = None) -> dict[str, Any]:
        return run(lambda: kb.update_board(board, name=name, columns=columns, labels=labels, settings=settings),
                   board_id(board), "board")

    def delete_board(board: str) -> dict[str, Any]:
        return run(lambda: kb.delete_board(board), key="board")

    def create_card(board: str, title: str, column: str = "", fields: dict | None = None) -> dict[str, Any]:
        out = run(lambda: kb.create_card(board, title, column, fields), board_id(board), "card")
        if out["ok"]:
            c = out["card"]
            record("kanban_create_card", c["board"], c["id"], None,
                   [{"command": "kanban_delete_card", "params": {"board": c["board"], "card": c["id"]}}])
        return out

    def _with_undo(command: str, board: str, card: str, fn: Callable[[], Any]) -> dict[str, Any]:
        try:
            b, before = kb.card(board, card)
        except Refused as exc:
            return {"ok": False, "error": str(exc)}
        out = run(fn, b["id"], "card")
        if out["ok"]:
            record(command, b["id"], before["id"], before,
                   [{"command": "kanban_restore_card", "params": {"board": b["id"], "card": before}}])
        return out

    def update_card(board: str, card: str, fields: dict) -> dict[str, Any]:
        return _with_undo("kanban_update_card", board, card, lambda: kb.update_card(board, card, fields))

    def move_card(board: str, card: str, column: str, before: str = "") -> dict[str, Any]:
        return _with_undo("kanban_move_card", board, card, lambda: kb.move_card(board, card, column, before))

    def delete_card(board: str, card: str) -> dict[str, Any]:
        return _with_undo("kanban_delete_card", board, card, lambda: kb.delete_card(board, card))

    def restore_card(board: str, card: dict) -> dict[str, Any]:
        return run(lambda: kb.restore_card(board, card), board_id(board), "card")

    def comment(board: str, card: str, text: str) -> dict[str, Any]:
        return run(lambda: kb.comment(board, card, text), board_id(board), "comment")

    def lock(board: str, card: str = "", column: str = "", task: str = "", minutes: float = 0) -> dict[str, Any]:
        return run(lambda: kb.lock(board, card, column, task, minutes), board_id(board), "lock")

    def unlock(board: str, card: str = "", column: str = "") -> dict[str, Any]:
        return run(lambda: kb.unlock(board, card, column), board_id(board), "")

    def ask_yield(board: str, card: str) -> dict[str, Any]:
        return run(lambda: kb.ask_yield(board, card), board_id(board), "")

    def force_unlock(board: str, card: str) -> dict[str, Any]:
        return run(lambda: kb.force_unlock(board, card), board_id(board), "lock")

    def activity(board: str, limit: int = 50) -> dict[str, Any]:
        try:
            return {"ok": True, **kb.activity(board, limit)}
        except Refused as exc:
            return {"ok": False, "error": str(exc)}

    def search(query: str, board: str = "") -> dict[str, Any]:
        words = [w for w in re.split(r"\s+", str(query or "").lower()) if w]
        if not words:
            return {"ok": False, "error": "Say what to look for."}
        hits = []
        for b in kb.boards():
            if board and board_id(board) != b["id"]:
                continue
            for c in kb.view(b["id"])["cards"]:
                text = " ".join([c["id"], c["title"], c.get("desc", ""),
                                 *(x.get("text", "") for x in c.get("comments", []))]).lower()
                if all(w in text for w in words):
                    hits.append({"board": b["id"], "boardName": b["name"], "card": c["id"], "title": c["title"],
                                 "column": next((x["title"] for x in b["columns"] if x["id"] == c["colId"]), "")})
        return {"ok": True, "items": hits[:50], "count": len(hits)}

    # ------------------------------------------------------------------ tools

    @api.tool(intent=INTENT, listener=False)
    def kanban_list_boards() -> dict:
        """List every Kanban board with its columns, card counts and who is working on it; start here."""
        return list_boards()

    @api.tool(intent=INTENT, listener=False)
    def kanban_get_board(board: str) -> dict:
        """Read one Kanban board: columns with WIP limits, labels, settings, every card, live locks and recent activity."""
        return get_board(board)

    @api.tool(intent=INTENT, listener=False)
    def kanban_templates() -> dict:
        """List the Kanban board templates (sprint, bug tracker, roadmap, island build...) for kanban_create_board."""
        return templates()

    @api.tool(intent=INTENT, listener=False)
    def kanban_create_board(name: str = "", template: str = "sprint") -> dict:
        """Create a Kanban board from a template (blank, sprint, bugs, roadmap, content, island, personal)."""
        return create_board(name, template)

    @api.tool(intent=INTENT, listener=False)
    def kanban_update_board(board: str, name: str | None = None, columns: list | None = None,
                            labels: list | None = None, settings: dict | None = None) -> dict:
        """Rename a Kanban board or replace its columns [{id?, title, wip}], labels [{id?, name, color}] or settings.

        Colors: blue, green, red, purple, amber, yellow. Settings: enforceWip, agentColLocks, agentsYield,
        agentsPaused, lockTimeout (seconds), allowForce. A removed column's cards move to the first column.
        """
        return update_board(board, name, columns, labels, settings)

    @api.tool(intent=INTENT, listener=False)
    def kanban_delete_board(board: str) -> dict:
        """Delete a Kanban board with all its cards and activity (asks the person first)."""
        return delete_board(board)

    @api.tool(intent=INTENT, listener=False)
    def kanban_create_card(board: str, title: str, column: str = "", fields: dict | None = None) -> dict:
        """Add a card to a Kanban board column (default: the first). fields: desc, priority, labels, due, assignee, checklist."""
        return create_card(board, title, column, fields)

    @api.tool(intent=INTENT, listener=False)
    def kanban_update_card(board: str, card: str, fields: dict) -> dict:
        """Change a Kanban card: title, desc, priority (urgent/high/medium/low), labels, due (YYYY-MM-DD),
        assignee {kind: person|ducky, name}, checklist [{id?, text, done}], attachments, icon.

        Holds the card for you while you work; refused while someone else has it locked.
        """
        return update_card(board, card, fields)

    @api.tool(intent=INTENT, listener=False)
    def kanban_move_card(board: str, card: str, column: str, before: str = "") -> dict:
        """Move a Kanban card to a column (title or id), optionally before another card; respects WIP limits and locks."""
        return move_card(board, card, column, before)

    @api.tool(intent=INTENT, listener=False)
    def kanban_delete_card(board: str, card: str) -> dict:
        """Delete one Kanban card (asks the person first); Revert in Changes brings it back."""
        return delete_card(board, card)

    @api.tool(intent=INTENT, listener=False)
    def kanban_restore_card(board: str, card: dict) -> dict:
        """Put a Kanban card back exactly as given (used by Revert in Changes)."""
        return restore_card(board, card)

    @api.tool(intent=INTENT, listener=False)
    def kanban_comment(board: str, card: str, text: str) -> dict:
        """Comment on a Kanban card; works even while the card is locked."""
        return comment(board, card, text)

    @api.tool(intent=INTENT, listener=False)
    def kanban_lock(board: str, card: str = "", column: str = "", task: str = "", minutes: float = 0) -> dict:
        """Lock a Kanban card, or a whole column, while you work on it, with a task people see ("Sorting by priority").

        A ducky's lock lasts 2 minutes from its last change unless minutes says otherwise. Release with kanban_unlock.
        """
        return lock(board, card, column, task, minutes)

    @api.tool(intent=INTENT, listener=False)
    def kanban_unlock(board: str, card: str = "", column: str = "") -> dict:
        """Release your lock on a Kanban card or column when you are done with it."""
        return unlock(board, card, column)

    @api.tool(intent=INTENT, listener=False)
    def kanban_ask_yield(board: str, card: str) -> dict:
        """Ask whoever holds a Kanban card or its column to let go; a ducky lets go within seconds."""
        return ask_yield(board, card)

    @api.tool(intent=INTENT, listener=False)
    def kanban_force_unlock(board: str, card: str) -> dict:
        """Take over a Kanban card someone else has locked (when the board allows it; asks the person first)."""
        return force_unlock(board, card)

    @api.tool(intent=INTENT, listener=False)
    def kanban_activity(board: str, limit: int = 50) -> dict:
        """Recent activity on a Kanban board: who (person, or which person's ducky) did what, newest first."""
        return activity(board, limit)

    @api.tool(intent=INTENT, listener=False)
    def kanban_search(query: str, board: str = "") -> dict:
        """Find Kanban cards whose id, title, description or comments contain every word of the query."""
        return search(query, board)

    # ------------------------------------------------------------------ panel

    def attach(board: str, card: str, name: str, b64: str, mime: str = "") -> dict[str, Any]:
        try:
            raw = base64.b64decode(b64 or "", validate=True)
        except ValueError:
            return {"ok": False, "error": "That file didn't arrive whole. Try again."}
        if len(raw) > MAX_ATTACH:
            return {"ok": False, "error": "Attachments are up to 15 MB. Add a link for bigger files."}
        try:
            b, c = kb.card(board, card)
        except Refused as exc:
            return {"ok": False, "error": str(exc)}
        att_id = slug(str(time.time_ns()))[-10:]
        safe = re.sub(r"[^a-z0-9._-]+", "-", str(name or "file").lower()).strip("-.")[:80] or "file"
        path = f"att/{b['id']}/{slug(c['id'])}/{att_id}-{safe}"
        kind = "image" if mime.startswith("image/") else "video" if mime.startswith("video/") else "file"
        row = {"id": att_id, "kind": kind, "name": str(name or safe)[:120], "path": path, "size": len(raw),
               "mime": mime[:80], "by": actor(), "at": time.time()}
        try:
            kb._guard(b, c)
            data.put_file(path, raw)
        except (Refused, PermissionError) as exc:
            return {"ok": False, "error": str(exc)}
        return update_card(b["id"], c["id"], {"attachments": [*c.get("attachments", []), row]})

    def attachment(path: str) -> dict[str, Any]:
        if not str(path or "").startswith("att/"):
            return {"ok": False, "error": "Not an attachment."}
        raw = data.get_file(path)
        if raw is None:
            return {"ok": False, "error": "That file hasn't arrived on this PC yet."}
        return {"ok": True, "b64": base64.b64encode(raw).decode("ascii")}

    def people(board: str = "") -> dict[str, Any]:
        """Who a card can be assigned to: you, your duckies, and everyone seen on the board."""
        name, _user = me()
        seen: dict[tuple[str, str], dict[str, Any]] = {("person", name or "You"): {"kind": "person", "name": name or "You"}}
        try:
            got = api.call_tool("ducky_list_duckies", {})
            rows = got.get("duckies") or got.get("items") or got.get("profiles") or [] if isinstance(got, dict) else got
            for d in rows or []:
                n = str((d.get("name") or d.get("title") or "") if isinstance(d, dict) else d)
                if n:
                    seen[("ducky", n)] = {"kind": "ducky", "name": n, "for": name}
        except Exception:  # noqa: BLE001 — the board's own people still show
            pass
        if board:
            try:
                v = kb.view(board)
                for who in [c.get("createdBy") for c in v["cards"]] + [a.get("by") for a in v["activity"]] + \
                        [x.get("by") for c in v["cards"] for x in c.get("comments", [])]:
                    if isinstance(who, dict) and who.get("name"):
                        seen.setdefault((who.get("kind", "person"), who["name"]),
                                        {k: who[k] for k in ("kind", "name", "for") if who.get(k)})
            except Refused:
                pass
        return {"ok": True, "people": list(seen.values())}

    def view_prefs() -> dict[str, Any]:
        try:
            from frontend.ui_web.plugin_host_api import prefs_plugin_get

            saved = prefs_plugin_get(pid) or {}
        except Exception:  # noqa: BLE001
            saved = {}
        return {"ok": True, "prefs": {k: saved.get(k, v) for k, v in VIEW_DEFAULTS.items()},
                "colors": list(COLORS), "priorities": list(PRIOS), "settings": dict(SETTINGS)}

    for name, fn in {
        "boards": list_boards, "view": get_board, "templates": templates, "create_board": create_board,
        "update_board": update_board, "delete_board": delete_board, "create_card": create_card,
        "update_card": update_card, "move_card": move_card, "delete_card": delete_card, "comment": comment,
        "lock": lock, "unlock": unlock, "ask_yield": ask_yield, "force_unlock": force_unlock,
        "activity": activity, "search": search, "attach": attach, "attachment": attachment, "people": people,
        "view_prefs": view_prefs,
        # Ducky's @ / / menu and search list every board (contributes.chat.reference_sources).
        "chat_refs": lambda: kb.reference_rows(),
    }.items():
        api.register_panel_rpc(name, fn)

    # ------------------------------------------------------------------ workflow nodes

    def _args(ctx: dict) -> dict[str, Any]:
        return {**(ctx.get("config") or {}), **{k: v for k, v in (ctx.get("inputs") or {}).items() if v not in (None, "")}}

    @api.register_pipeline_node("kanban.list_boards")
    def node_list_boards(ctx: dict) -> dict:
        out = list_boards()
        return {**out, "count": len(out["boards"])}

    @api.register_pipeline_node("kanban.get_board")
    def node_get_board(ctx: dict) -> dict:
        return get_board(str(_args(ctx).get("board") or ""))

    @api.register_pipeline_node("kanban.create_card")
    def node_create_card(ctx: dict) -> dict:
        a = _args(ctx)
        return create_card(str(a.get("board") or ""), str(a.get("title") or ""), str(a.get("column") or ""),
                           {k: a[k] for k in ("desc", "priority", "due") if a.get(k)})

    @api.register_pipeline_node("kanban.move_card")
    def node_move_card(ctx: dict) -> dict:
        a = _args(ctx)
        return move_card(str(a.get("board") or ""), str(a.get("card") or ""), str(a.get("column") or ""))

    @api.register_pipeline_node("kanban.comment")
    def node_comment(ctx: dict) -> dict:
        a = _args(ctx)
        return comment(str(a.get("board") or ""), str(a.get("card") or ""), str(a.get("text") or ""))
