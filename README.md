# Kanban

Open-source [UEFN-Ducky](https://github.com/UEFN-Ducky/UEFN-Ducky) Store plugin: Kanban boards that people and duckies work on together.

Desktop plugin id `kanban`. Install or update from **Settings → Store** in the app — do not install from a zip by hand.

## What it does

- **A Kanban tab**: boards from templates (blank, sprint, bug tracker, roadmap, content calendar, island build, personal week), columns with WIP limits, cards with icon, description, checklist, labels, priority, due date, assignee (a person or a ducky), comments, attachments and covers, drag and drop, search, filters and an activity feed.
- **Live with a team**: pick a team's shared copy in the plugin's data bar and every teammate, and every teammate's ducky, sees changes, locks and activity live.
- **Locks that name the ducky**: opening a card locks it to you (it idles out); a ducky's change holds the card for two minutes and reads "Builder (Ilya's ducky) · Editing", never just "Ilya". Duckies can lock whole columns while they sort them; people can ask a ducky to yield, or force unlock. Comments stay open on locked cards.
- **Agent tools** (`kanban_*` on the shared `uefn-ducky` MCP): list, read, search, create, update, move, delete and restore cards; comment; lock, unlock, ask to yield, force unlock; boards, columns, labels and the board's team rules.
- **Workflow nodes** (the **Kanban** group): List boards, Read board, Add card, Move card, Comment on card, plus two ready-made workflows.
- **Settings → Kanban**: how cards look on this PC (density, which fields show).

Every card change goes into Ducky's Changes ledger, so Revert undoes it.

## Build

```bash
py scripts/build_zip.py
py scripts/release.py --publish --changelog "…"   # commit + push, zip, upload, publish to the Store
```

## Test

```bash
py -m pytest -q --import-mode=importlib backend/test_kanban.py
```

No app needed: the self-check runs the board engine on an in-memory store.

## License

MIT. Copyright (c) 2026 Mindful Path Company, LLC. See [LICENSE](LICENSE).
