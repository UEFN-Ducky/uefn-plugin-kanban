---
name: kanban
description: "Kanban boards for people and duckies: list, read, create and move cards, comment, lock cards or columns while you work, WIP limits, with kanban_* tools."
keywords: kanban, board, cards, backlog, sprint, to do, task board, wip limit, lock card, move card, plan work
---

# Kanban

Boards live in the Kanban plugin's data: Local, or a team's shared copy (then teammates
and their duckies see every change live). Everything you do is labelled as **you, the
ducky, working for your person**: "Builder (Ilya's ducky) moved …", never just "Ilya".

## Read first

- `kanban_list_boards()`: every board with columns, card counts and who is editing.
- `kanban_get_board(board)`: columns (with `wip` limits), labels, settings, every card,
  live `locks` (`who`, `task`, `mine`) and recent activity. `board` is the id or name.
- `kanban_search(query, board?)`: cards whose id, title, description or comments
  contain every word.
- `kanban_activity(board, limit?)`: who did what, newest first.

## Change cards

- `kanban_create_card(board, title, column?, fields?)`: fields `desc`, `priority`
  (`urgent` `high` `medium` `low`), `labels` (names or ids), `due` (`YYYY-MM-DD`),
  `assignee` `{kind: "person"|"ducky", name}`, `checklist` `[{text, done}]`.
- `kanban_update_card(board, card, fields)`: the same fields plus `title`, `icon`,
  `attachments` (links: `{kind: "link", name, url}`). Send the whole `checklist` or
  `labels` array: it replaces the old one.
- `kanban_move_card(board, card, column, before?)`: column title or id; `before` a card id.
- `kanban_comment(board, card, text)`: works even on a locked card.
- `kanban_delete_card(board, card)` asks the person first; Revert in Changes undoes
  any card change (`kanban_restore_card` is what Revert calls).

## Locks: work alongside people

- Your change holds the card for 2 minutes after your last edit, so people see
  "Builder (Ilya's ducky) · Editing" on it.
- For longer work, `kanban_lock(board, card, task="Writing the spec")`, or a whole
  column with `kanban_lock(board, column="Backlog", task="Sorting by priority")`, then
  **always** `kanban_unlock(...)` when done.
- A change to a card someone else holds is refused with who holds it: don't retry.
  Ask with `kanban_ask_yield(board, card)`, work on something else, or tell your person.
  `kanban_force_unlock` takes it over (asks the person first) when the board allows it.
- A person can ask you to yield: your lock then ends within 15 s. Board settings can
  pause duckies, forbid column locks, or make duckies yield at once.

## Boards

- `kanban_templates()`, `kanban_create_board(name, template)`: `blank`, `sprint`,
  `bugs`, `roadmap`, `content`, `island`, `personal`.
- `kanban_update_board(board, name?, columns?, labels?, settings?)`: `columns`
  `[{id?, title, wip}]` replaces the list (a removed column's cards move to the first);
  label colors `blue green red purple amber yellow`; settings `enforceWip`,
  `agentColLocks`, `agentsYield`, `agentsPaused`, `lockTimeout` (s), `allowForce`.
- `kanban_delete_board(board)` asks the person first.

## Refusals

Every tool returns `{ok: false, error}` with a sentence for the person: a lock (who and
what they are doing), a full column ("Review is at its WIP limit (3)"), paused duckies,
or a read-only team copy. Say it in your reply; don't work around it.

## Workflows

Nodes `kanban.list_boards`, `kanban.get_board`, `kanban.create_card`,
`kanban.move_card`, `kanban.comment`; templates "Plan into Kanban cards" and
"Report on a Kanban board".
