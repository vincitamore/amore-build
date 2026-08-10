---
name: speculum
description: "Speculum — a local mirror over your own Amore Build agent sessions. It walks ~/.amore/sessions, builds a rebuildable sqlite index (speculum.sqlite under ~/.amore/instruments/speculum/), runs heuristic probes (rage-rate, frustration-markers, tool-mix, stuck-loop, apology-rate, operator-correction, sensitive-content, stale-corpus) with Wilson 95% confidence intervals, and reports per-model token/turn usage. Local commands (ingest/status/forget/scan/usage) never call a model or open a socket. Optional lenses (session-postmortem, pattern-extraction, usage-story) send a scrubbed session slice through YOUR own amore configuration to the model that config routes to — opt-in by explicit `speculum lens <name>`; the scrubber fails closed (typed placeholders, 100 KB cap, refuse-over-send) and every invocation is recorded in an append-only audit log. Use when operating speculum: indexing sessions, running probes, reading usage, using or adding lenses, or checking what a session actually did. SKIP when the work is the org system itself (that is iris) or the amore fork (/amore-build)."
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# speculum — local session mirror

Speculum mirrors your own agent sessions: it reads the session files the harness
already writes, builds a local sqlite index you can query, and turns the index
into answers — heuristic probes with honest confidence intervals, per-model
usage accounting, and opt-in qualitative reads. You can also add probes and
lenses of your own; the shape below is the contract.

> The mirror is the thing itself: what speculum shows is your own work, derived
> from your own session files, rebuilt from them, never a copy of record.

---

## Privacy posture (this is the product)

- **Probes and usage stay on the machine.** They report only against the local
  index and never open a socket.
- **Ingest is explicit.** Nothing is indexed until you run `speculum ingest`.
- **`forget` is complete for the index.** `speculum forget <session-prefix>`
  deletes that session's rows and marks its source file forgotten so a later
  ingest will not re-index it. Source files under `~/.amore/sessions` are left
  alone. Every purge is recorded in a separate `forget-audit.jsonl` ledger.
- **The index is a derived database.** Source of truth remains the session tree;
  `speculum ingest --full` wipes and rebuilds from byte 0.
- **Lenses are opt-in egress.** Nothing leaves the machine until you type
  `speculum lens <name>`. The selected slice is scrubbed locally first
  (secrets, emails, absolute home paths → typed placeholders). The scrubber
  fails closed: residual unredactable content or an oversize payload aborts the
  lens. No partial sends, ever. Every invocation (accepted, refused, dry-run)
  is appended to the audit log.

## Install / run

```bash
# via the harness (installs the binary beside amore)
amore init --with-speculum   # or rebuild from instruments/speculum in the fork

cd instruments/speculum      # source checkout
bun install
bun run src/cli.ts --help
```

Compiled single-file binary: `bun run build:compile` → `dist/speculum-<os>-<arch>.exe`.

## Commands

| Command | Purpose |
|---|---|
| `speculum ingest` | Walk sessions, parse `updates.jsonl`, write sqlite (`--dry-run` walks only; `--full` rebuilds; prints stage timings/progress) |
| `speculum status` | Session/event counts, ingest freshness, probe registry |
| `speculum doctor` | Operational health checks on the local index (db integrity, schema version, ingest freshness, probe registry) |
| `speculum forget <prefix>` | Purge one session from the index (disk files untouched); append the purge to the `forget-audit.jsonl` ledger |
| `speculum scan` | Run all probes (or `--probe <name>`), `--project`/`--since`/`--until` filtered; `--hits`/`--verbose` print hit evidence on the terminal |
| `speculum usage` | Per-model token and turn totals (no prices) |
| `speculum lenses` | List available lenses and their egress notes |
| `speculum lens <name>` | Run a lens over a selected, scrubbed slice (`--dry-run` = selection+scrub+audit only) |
| `speculum audit [-n N]` | Tail the append-only lens audit log |

Selection flags for lenses: `--session`, `--last-n`, `--project`, `--since` /
`--until`, `--probe-hit <probe>`. Default when no selection: `--last-n 1`.

## What is ingested

`~/.amore/sessions/<urlencoded-cwd>/<session-uuid>/updates.jsonl` is the
authoritative stream (joined with `summary.json` and `subagents/*/meta.json` for
project path, model id, and parent→child linkage). Handled kinds:
`user_message_chunk`, `agent_message_chunk`, `tool_call`, `tool_call_update`,
`turn_completed` (usage), plus plan/task/hook events. Unknown kinds are skipped
without failing; truncated lines are tolerated.

## Probes — heuristic, with honest intervals

Every probe returns a rate or count with a **Wilson 95% confidence interval**
and is labeled **heuristic**: the pattern banks are unvalidated on your corpus.
Treat the numbers as investigative signals, not measured precision. Shipped
probes: `rage-rate` · `frustration-markers` · `tool-mix` · `stuck-loop` ·
`apology-rate` · `operator-correction` · `sensitive-content` · `stale-corpus`.

Each result carries a `hits` array — the evidence (session, timestamp, quote
line) behind the finding. `scan --json` always includes hits; `scan --hits` /
`--verbose` prints them on the terminal too. `sensitive-content` scans the
`tool_input`/`tool_output` side channels as well as operator/assistant text.

## Lenses — opt-in, scrubbed, audited

Lenses select a session slice, scrub it, and send it through **your own amore
configuration** (binary `amore` on PATH, or `SPECULUM_AMORE_BIN`) in a headless
single-shot call. Speculum ships no API keys and no provider SDKs — what answers
is whatever your config routes to. Built-in lenses:

| Lens | Role |
|---|---|
| `session-postmortem` | What went wrong and where the loop stalled (single session) |
| `pattern-extraction` | Recurring tool-use and correction patterns across a slice |
| `usage-story` | Narrative read of the session arc and thrash texture |

Successful runs write a dated markdown report under
`~/.amore/instruments/speculum/lens-reports/`. Every invocation appends to
`~/.amore/instruments/speculum/lens-audit.jsonl` with the selection, payload
bytes, scrub counts, decision, and (on send) model id + token usage.

**Before any send that matters, run `speculum lens <name> --dry-run`** — it does
selection + scrub + audit and prints the scrub report without touching a model.

## Usage accounting

`speculum usage` aggregates `turn_completed.usage`: input/output/cached-read/
reasoning/total tokens, turns, and distinct sessions, grouped by model id.
**No price table** — provider prices vary per user and account; counts and
tokens only.

## Config / environment

| Variable | Default | Role |
|---|---|---|
| `AMORE_HOME` | `~/.amore` | Amore home root |
| `SPECULUM_SESSIONS_DIR` | `$AMORE_HOME/sessions` | Sessions tree |
| `SPECULUM_HOME` | `$AMORE_HOME/instruments/speculum` | Instrument data dir |
| `SPECULUM_DB` | `$SPECULUM_HOME/speculum.sqlite` | Sqlite path |
| `SPECULUM_AUDIT_PATH` | `$SPECULUM_HOME/lens-audit.jsonl` | Lens audit log |
| `SPECULUM_REPORTS_DIR` | `$SPECULUM_HOME/lens-reports` | Lens reports |
| `SPECULUM_AMORE_BIN` | `amore` on PATH | Amore binary for lenses |

## Adding a probe or lens

Probes live in `src/probes/` registered in `src/probes/index.ts`; each is a
function `(db, opts) → ProbeResult` with `value`, Wilson `ciLow`/`ciHigh`,
`n`, `unit`, `summary`, `hits`, and `heuristic: true`. Lenses live in
`src/lenses/` as prompt templates plus selection guidance. Tests run with
`bun test` (fixtures are synthetic only — never read live session content into
assertions; lens tests stub the amore binary).

## Notes

- The catalog's own staleness rule applies here too: **an instrument skill
  nobody revises describes a system that no longer exists.** When you change
  speculum's commands, probes, lenses, or privacy behavior, update this
  document in the same change.
- The installed `--version` string is real but constant across releases; to
  check currency, compare the binary's hash against the release assets, not the
  version string.