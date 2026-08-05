# Speculum

A **local mirror** over your own Amore Build agent sessions.

Speculum walks `~/.amore/sessions`, builds a rebuildable sqlite index, and runs
heuristic probes plus token/turn usage accounting. It does not call models, open
network sockets, or upload anything.

## Privacy doctrine

- **Everything stays on the machine.** Probes and usage report only against the
  local index.
- **Ingest is explicit.** Nothing is indexed until you run `speculum ingest`.
- **`forget` is complete for the index.** `speculum forget <session-prefix>`
  deletes that session's events, usage rows, and session row, and marks the
  source `updates.jsonl` forgotten so a later ingest will not re-index it.
  Source files under `~/.amore/sessions` are left alone (delete those with the
  harness if you want the originals gone).
- The index is a **derived** database. Source of truth remains the session tree.

## Install / run

```bash
cd instruments/speculum
bun install
bun run src/cli.ts --help
```

Binary entry: `bun run src/cli.ts` (package name `@amore/speculum`).

## Commands

| Command | Purpose |
|---------|---------|
| `speculum ingest` | Walk sessions, parse `updates.jsonl`, write sqlite |
| `speculum ingest --dry-run` | Walk + parse + count only (no writes) |
| `speculum status` | Session/event counts, ingest freshness, probe list |
| `speculum forget <prefix>` | Purge one session from the index |
| `speculum scan` | Run all probes (or `--probe <name>`) |
| `speculum usage` | Per-model token and turn totals |

Common flags: `--json`, date filters `--since` / `--until` where noted.

## What is ingested

Layout:

```
~/.amore/sessions/<urlencoded-cwd>/<session-uuid>/
  updates.jsonl      # authoritative ACP sessionUpdate stream
  summary.json       # model id, cwd, timestamps
  subagents/*/meta.json   # parent → child linkage
```

`updates.jsonl` kinds handled: `user_message_chunk`, `agent_message_chunk`,
`tool_call`, `tool_call_update`, `turn_completed` (usage), plus plan/task/hook
events. Unknown kinds are skipped without failing the file. Truncated lines are
tolerated.

Store location: `~/.amore/instruments/speculum/speculum.sqlite`.

## Probes (heuristic)

Every probe returns a rate or count with a **Wilson 95% confidence interval**.
Output is labeled **heuristic**: the pattern banks are unvalidated on this
corpus. Treat numbers as investigative signals, not measured precision.

| Probe | What it looks for |
|-------|-------------------|
| `rage-rate` | Profanity / strong language in operator messages |
| `frustration-markers` | Caps spans, `??`, "still … failing", minced oaths |
| `tool-mix` | Sessions where one tool dominates (≥70% of ≥20 calls) |
| `stuck-loop` | Near-identical tool call fingerprints in a short window |
| `apology-rate` | Agent self-correction register ("you're right", owned error, …) |
| `operator-correction` | Operator redirect / correction phrasing |
| `sensitive-content` | Key/credential patterns (SSH, GitHub, AWS, xAI, OpenRouter, Amore env) |
| `stale-corpus` | Primary sessions older than 30 days |

Sensitive-content matching is best-effort regex, not a security guarantee.

## Usage accounting

`speculum usage` aggregates `turn_completed.usage` fields:

- input / output / cached-read / reasoning / total tokens
- turn counts and distinct sessions
- grouped by model id

**No price table in v1.** Provider prices vary per user and account. Speculum
reports counts and tokens only.

## Config / environment

| Variable | Default | Role |
|----------|---------|------|
| `AMORE_HOME` | `~/.amore` | Amore home root |
| `SPECULUM_SESSIONS_DIR` | `$AMORE_HOME/sessions` | Sessions tree (tests/fixtures) |
| `SPECULUM_HOME` | `$AMORE_HOME/instruments/speculum` | Instrument data dir |
| `SPECULUM_DB` | `$SPECULUM_HOME/speculum.sqlite` | Sqlite path |

## Tests

```bash
bun test
```

Fixtures are synthetic only. The suite never reads conversational content from
live sessions into assertions.

## Out of scope (v1)

- Lens runner / LLM analysis of transcripts
- Dataset builder for fine-tuning
- Ingest adapters for other agent harnesses
- Price tables and cost estimates
