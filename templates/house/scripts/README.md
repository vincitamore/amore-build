# House scripts

Utilities the house authors for its own corpus. Zero product-runtime coupling —
adopters run these against their house root (`AGENTS.md` + `tasks/`).

| Script | Runtime | Purpose |
|--------|---------|---------|
| [`sync_orientation_rules.py`](./sync_orientation_rules.py) | **Python 3** | Materialize `context/principle-lattice.md` (+ optional `context/praxis.md`) into harness rules; `--check` for drift |

## Requirements

- **Python 3** — for `sync_orientation_rules.py` (stdlib only: argparse, hashlib, pathlib, re)

## House lint — `iris regula lint`

**The house lint is `iris regula lint`, not a script in this directory.** The
former hand-rolled `house_lint.ts` was retired when iris's regula lint reached
and exceeded its coverage (its rule set + the coverage matrix live in the iris
instrument: `instruments/iris/packages/regula/src/lint.ts`). Nothing should
cite `bun scripts/house_lint.ts`; the lint test surface lives in
`instruments/iris/packages/regula/src/lint.test.ts`.

```bash
# From the house root — errors fail (exit 1); warnings don't; notes skip
iris regula lint
iris regula lint --folder tasks     # scope to one org folder
```

Covers: frontmatter schema, type↔folder, inbox folder admission, status↔folder
placement, source/repeat domains, date formats, lifecycle fields
(blocked-by/completed/paused/trigger-to-unpause/inbox-terminal/snoozed-until),
knowledge updated+tags, wikilink presence + resolution (context/ included,
warning severity), current-state staleness, active-task staleness, project-map
coverage + staleness, same-stem collisions, and — for houses coupled to a
canonical lattice — lattice + orientation-rules drift:

- **lattice-drift** — when `LATTICE_CANONICAL` is set (path to an external
  canonical lattice), the local `context/principle-lattice.md` body is
  compared against it; error on drift, skip-with-note when unset.
- **orientation-rules-drift** — when `.amore/` or `.grok/` exists, runs
  `sync_orientation_rules.py --check` (adds `--grok-compat` if only `.grok/`
  is present) and errors on non-zero.

## sync_orientation_rules.py

Regenerates derived rules files from canonical sources under `context/`.

| Flag | Effect |
|------|--------|
| *(default)* | Write to `.amore/rules/` (Amore Build lane) |
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

## Tests

No test suite ships from this directory — the lint test surface is regula's
(`instruments/iris/packages/regula/src/lint.test.ts`). The `sync-tree`
fixture under `tests/fixtures/` is retained for a future
`sync_orientation_rules.py` test (no consumer today) and never ships to a
house (init filters `scripts/tests/`).

## Catalog authority

Status domains and required keys are encoded by `@amore/regula`
(`instruments/iris/packages/regula/src/schema.ts`), the single
schema/lifecycle authority both iris clients defer to — faithful
machine-readable encoding of AGENTS.md, pinned by regula's own tests.
