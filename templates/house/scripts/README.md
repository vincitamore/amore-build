# House scripts

Utilities the house authors for its own corpus. Zero product-runtime coupling —
adopters run these against their house root (`AGENTS.md` + `tasks/`).

| Script | Runtime | Purpose |
|--------|---------|---------|
| [`house_lint.ts`](./house_lint.ts) | **Bun** (zero deps) | Schema-validate `tasks/`, `inbox/`, `knowledge/`, `reminders/` against AGENTS.md catalogs; wikilink existence; optional lattice + orientation-rules drift |
| [`sync_orientation_rules.py`](./sync_orientation_rules.py) | **Python 3** | Materialize `context/principle-lattice.md` (+ optional `context/praxis.md`) into harness rules; `--check` for drift |

Tests: `bun test` from this directory (or `bun test templates/house/scripts` from the product repo). Fixture trees live under [`tests/fixtures/`](./tests/fixtures/).

## Requirements

- **Bun** ≥ 1.1 — for `house_lint.ts` and the test suite (`bun:test`)
- **Python 3** — for `sync_orientation_rules.py` (stdlib only: argparse, hashlib, pathlib, re)

## house_lint.ts

Validates the four scope directories against pinned catalogs (status domains,
folder-follows-status, required keys, date formats, lifecycle fields, wikilinks).
Tree-level rules:

- **lattice-drift** — only when `LATTICE_CANONICAL` is set (path to an external
  canonical lattice); otherwise skipped with a note (local
  `context/principle-lattice.md` is the authority for single-house adopters).
- **orientation-rules-drift** — when `.selene/` or `.grok/` exists, runs
  `sync_orientation_rules.py --check` (adds `--grok-compat` if only `.grok/` is
  present).

### Invocation

```bash
# From the house root
bun scripts/house_lint.ts
bun scripts/house_lint.ts --json
bun scripts/house_lint.ts --root /path/to/house

# Exit codes
#   0  clean
#   1  findings
#  64  foreign root (no AGENTS.md + tasks/ at the resolved path)
```

House-root guard: the tool refuses to lint a tree that lacks both `AGENTS.md`
and a `tasks/` directory. With `--root`, the path must *itself* be the house
root (no silent walk-up). Without `--root`, the default is the parent of
`scripts/` (the house root when the template is cloned as-is), with walk-up
from that candidate if needed.

## sync_orientation_rules.py

Regenerates derived rules files from canonical sources under `context/`.

| Flag | Effect |
|------|--------|
| *(default)* | Write to `.selene/rules/` (Selene Build lane) |
| `--grok-compat` | Write to `.grok/rules/` (upstream-grok lane) |
| `--check` | Exit 0 if derived files match sources; exit 1 on missing/drift (no write) |

### Invocation

```bash
# From the house root (or any cwd under it; walks up for AGENTS.md + tasks/)
python scripts/sync_orientation_rules.py
python scripts/sync_orientation_rules.py --check
python scripts/sync_orientation_rules.py --grok-compat
python scripts/sync_orientation_rules.py --check --grok-compat

# Override root
ORG_ROOT=/path/to/house python scripts/sync_orientation_rules.py --check
```

Praxis is emitted only when `context/praxis.md` exists (15KB ceiling). If the
source is removed, the derived `praxis.md` under the rules dir is deleted on
the next sync.

## Catalog authority

Status domains and required keys are pinned by exact-equality tests and must
match the public template schemas:

- Task: `active`/`blocked` at `tasks/` root; `review`, `backlog`, `incubating`,
  `paused`, `complete` in their named subfolders
- Inbox: `open` in active folders; terminal `resolved`/`dropped`/`superseded`
  under `*/resolved/`; captures may omit `status`
- Reminders: `pending`/`snoozed`/`ongoing` at root; `completed`/`dismissed`
  under `reminders/completed/`
