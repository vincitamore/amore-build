---
name: iris
description: "Iris — your knowledge/org instrument, installed with every Amore Build house. It is a daemon with clients: the `iris` multi-tool (org verbs: task/inbox/knowledge/reminder CRUD against your house's files, plus the lint `iris regula lint` and daemon index reads for graph/search/backlinks) and the dash (bare `iris` / `iris dash` — the OpenTUI glass). The Bun daemon runs on 127.0.0.1:3853 (loopback only) and owns the live index: recursive file-watcher, wikilink/backlink resolver, graph, fuzzy search. Writes go through @amore/regula, the single write-core that owns schema, folder placement, lifecycle, and the lint rule set — every org mutation is a regula mutation, never a hand-edit that skips the contract. Use when operating or developing iris: indexing your house, org CRUD, the lint surface, the knowledge graph, the dash, or the daemon. SKIP for plain file edits inside your house that touch no org structure — that is ordinary work. NOT the fork itself (/amore-build); NOT speculum (/speculum — the session-mirror companion); NOT the network CLI (/network-cli)."
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# iris — knowledge/org instrument

Iris is the lens onto your org system. It keeps a **live index** of your house
(documents, wikilinks, graph, search) and gives you one consistent surface for
org CRUD — tasks, inbox, knowledge, reminders — with the schema contract
enforced, not remembered.

> *iris*: in Homer the messenger whose path is the arc itself; in optics the
> ring that admits light into every instrument. Both readings name one function
> — fetching what is asked for, and regulating what gets through.

---

## The one architectural fact: daemon + clients, reads vs writes

- **The Bun daemon owns READS** — `127.0.0.1:3853`, loopback only. Live index
  (recursive file-watcher), wikilink/backlink resolver, graph, fuzzy search.
  This is what the CLI and dash read.
- **`@amore/regula` owns WRITES** — schema, folder placement, legal lifecycle
  transitions, lint. The single write-core every mutation goes through.
- **Clients:** `iris` = org verbs + daemon reads (the agent surface); bare
  `iris` / `iris dash` = the OpenTUI dash (the operator surface). A client exit
  never stops the daemon.

This split is why org CRUD works even when the daemon is down (regula is
direct-file) — only index reads (graph/search/backlinks) need the daemon.

## Getting started

```bash
iris status                 # orientation counts across your house
iris commands --json        # THE canonical verb surface — the manifest
```

`iris commands --json` is the source of truth for what the CLI can do; the
lists below are an orientation snapshot, and the manifest wins when they
disagree.

## The CLI surface

| Area | Verbs |
|---|---|
| tasks | `task list\|get\|create\|complete\|pause\|block\|status\|update` |
| inbox | `inbox capture\|list\|get\|resolve\|move\|archive\|promote` |
| knowledge | `knowledge list\|get\|create\|update` |
| reminders | `reminder list\|get\|create\|complete\|dismiss\|snooze\|update` |
| lint | `lint [--folder <dir>]` — the house lint; errors fail, warnings don't |
| index reads | `graph [--scope --depth]` · `links <path>` · `search <q> --mode index` |
| status | `status [--json]` |

**Org-root resolution:** commands resolve the org root from `$IRIS_ORG_ROOT` or
the house markers (`AGENTS.md` + `tasks/`), and refuse rather than silently fall
back to the cwd.

**Mutation trust:** reads work on any resolved root. Mutations require a house
root (orientation doc + `tasks/`) or an explicit opt-in
(`--allow-foreign-root`, `IRIS_ALLOW_FOREIGN_ROOT=1`, or a path in
`~/.iris/allowed-roots.json`). Refusals name the one-line remedy.

## The lint surface — `iris regula lint`

`iris regula lint` is the house lint: frontmatter schema, type↔folder
placement, status↔folder lifecycle, wikilink resolution (broken links are
errors in the four scope dirs), current-state staleness, and lattice-orientation
drift. **Errors fail (exit 1); warnings don't.** A session that touches org
structure ends with it green.

## The dash

Bare `iris` opens the OpenTUI dash: Dashboard / Tasks / Inbox / Reminders /
Knowledge / Files / Graph / Forge. The graph is the headline view (force-directed
over the daemon's `/api/graph`), and Recent Changes renders the
`## Recent structural changes (DATE)` sections of your `context/current-state.md`.
`iris dash` is the same surface; it re-execs a sibling `iris-dash-*` binary when
present.

## Operating the daemon

`iris daemon [--port N] [org_root]` (or let the dash spawn it). Loopback only;
all `/api/*` routes are unauthenticated on loopback (a local client needs no
token). Routes the agent reaches for: `/api/daemon/status` (handshake),
`/api/search`, `/api/graph` (`?shape=v2`), `/api/files` (links/backlinks).
`IRIS_PORT` / `IRIS_ORG_ROOT` / `IRIS_TIMEOUT_MS` / `IRIS_ALLOW_FOREIGN_ROOT` /
`IRIS_THEME` are the knobs. State lives under `~/.iris`.

## Editing the org system, correctly

Everything you mutate through the CLI is a **regula mutation**: the correct
status flip plus the folder move plus the date, atomically. The reason this is
worth it: "grade was done in one move, not three" — a mutation is correct by
construction. If a verb makes the correct action harder than hand-editing the
file, that verb fails its bar; tell the maintainer, don't route around it.

## Building / developing

Source is the Bun workspace `instruments/iris/` in the amore-build fork
(packages: daemon, regula, cli, tui, parity). `bun test` per package is the
contract's pin — a new lint rule or lifecycle transition lands WITH its test
case. The dash is a separate compiled artifact (`bun run build:compile
--with-dash`). When you change the CLI surface, the daemon API, or the lint
rule set, update this document in the same change.

## Notes

- **A stale skill is worse than no skill.** Iris is under active construction;
  keep this map accurate as you build. When a verb list and
  `iris commands --json` disagree, the manifest wins and this page is stale.
- The compiled multi-tool embeds the daemon; the dash is a separate artifact
  beside it.