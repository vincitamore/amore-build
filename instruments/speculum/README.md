# Speculum

A **local mirror** over your own Amore Build agent sessions.

Speculum walks `~/.amore/sessions`, builds a rebuildable sqlite index, and runs
heuristic probes plus token/turn usage accounting. Local commands never call
models or open network sockets. Optional **lenses** send a scrubbed session
slice through the user's own amore configuration for a qualitative read.

## Privacy doctrine

Speculum has a **dual posture**: almost everything is local-only; the single
egress path is explicit, scrubbed, audited, and fail-closed.

**Local verbs never egress.** `ingest`, `status`, `forget`, `scan`, and `usage`
read and write only on this machine. Probes never call models or open network
sockets. They report only against the local sqlite index.

**The only egress is the opt-in lens path.** Nothing is sent without an explicit
`speculum lens <name>` command. Before any model call, the selected slice is
scrubbed locally (secrets, emails, absolute home paths). The scrubber fails
closed: residual unredactable content or an oversize payload aborts the lens.
Nothing partial is ever sent. Every invocation (including dry-run and refusal)
is recorded in the local audit log.

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

Compiled single-file binary (host OS/arch):

```bash
bun run build:compile
# → dist/speculum-windows-x64.exe  (or darwin/linux + x64/arm64)
```

## Commands

| Command | Purpose |
|---------|---------|
| `speculum ingest` | Walk sessions, parse `updates.jsonl`, write sqlite |
| `speculum ingest --dry-run` | Walk + parse + count only (no writes) |
| `speculum status` | Session/event counts, ingest freshness, probe list |
| `speculum forget <prefix>` | Purge one session from the index |
| `speculum scan` | Run all probes (or `--probe <name>`) |
| `speculum usage` | Per-model token and turn totals |
| `speculum lenses` | List available lenses and egress notes |
| `speculum lens <name>` | Run a lens over a selected, scrubbed slice |
| `speculum lens <name> --dry-run` | Selection + scrub + audit only (no model) |
| `speculum audit [-n N]` | Tail the append-only lens audit log |

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

## Lenses (opt-in egress)

Lenses select a session slice from the local index, scrub it, and send the
scrubbed prompt through the **user's own amore configuration** (binary
`amore` on PATH, or `SPECULUM_AMORE_BIN`). The model that answers is whatever
that configuration routes to. Speculum does not ship API keys or provider SDKs.

| Lens | Role |
|------|------|
| `session-postmortem` | What went wrong and where the loop stalled |
| `pattern-extraction` | Recurring tool-use and correction patterns |
| `usage-story` | Narrative read of the session arc and thrash texture |

Selection flags: `--session`, `--last-n`, `--project`, `--since` / `--until`,
`--probe-hit <probe>`. Default when no selection is given: `--last-n 1`.

**Scrub (fail-closed).** Before any model call, secret-shaped strings (the same
classes the sensitive-content probe flags, plus password-style assignments),
email addresses, and absolute home paths are replaced with typed placeholders.
The scrubber returns counts by class. If redaction cannot be completed with
confidence, or the prompt-file would exceed 100 KB, the lens **aborts** with a
clear message. There is no silent truncation and no "warn and send" path.

**Dry-run.** `speculum lens <name> --dry-run` runs selection, scrub, and audit,
prints the scrub report, and never spawns amore.

**Reports.** Successful lens runs write a dated markdown report under
`~/.amore/instruments/speculum/lens-reports/`, labeled with the lens name and
the model id from the amore JSON envelope when present.

**Audit log.** Every lens invocation appends one JSONL record (timestamp, lens,
selection, payload bytes, scrub counts, accepted/refused/dry-run + reason, and
on send: model id and token usage). Path:

`~/.amore/instruments/speculum/lens-audit.jsonl`

Also printed by `speculum lens --help` and `speculum lenses`.

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
| `SPECULUM_AUDIT_PATH` | `$SPECULUM_HOME/lens-audit.jsonl` | Lens audit log |
| `SPECULUM_REPORTS_DIR` | `$SPECULUM_HOME/lens-reports` | Lens report directory |
| `SPECULUM_AMORE_BIN` | `amore` on PATH | Amore binary for lenses |

## Tests

```bash
bun test
```

Fixtures are synthetic only. The suite never reads conversational content from
live sessions into assertions. Lens tests stub the amore binary (no network).

## Out of scope

- Dataset builder for fine-tuning
- Ingest adapters for other agent harnesses
- Price tables and cost estimates
- Multi-harness ingest for other agent products
- Full interactive TUI
