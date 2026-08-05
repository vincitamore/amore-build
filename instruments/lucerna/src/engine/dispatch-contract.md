# Lucerna dispatch contract (SF-1)

Shared discipline for every consumer that spawns `amore` headless through
Lucerna's driver (`src/engine/amore-headless.ts`). Speculum lenses, vinculum
judges, and Lucerna agentic dreams inherit these rules.

## Wall-timeout tree-kill

Every agentic (and long-running) spawn takes a configurable wall-clock timeout
(`wallMs`; Lucerna agentic default 20 minutes via `LUCERNA_AGENTIC_WALL_MS`).

On expiry the driver kills the **entire process tree**:

| Platform | Mechanism |
|----------|-----------|
| Windows | `taskkill /T /F /PID <child>` (tree kill) |
| Unix | process-group kill (`kill(-pid, SIGKILL)`) when the child was spawned detached; fallback `child.kill(SIGKILL)` |

Call site: `killProcessTree` + `runAmoreProcess` in `amore-headless.ts`.

## Web access OFF for maintenance dreams

Verified against the live pager CLI surface in
`crates/codegen/xai-grok-pager/src/app/cli.rs` (amore multi-call binary):

| Flag | Role |
|------|------|
| `--disallowed-tools <TOOLS>` | Comma-separated built-in tools to remove for the session |
| `--tools <TOOLS>` | Comma-separated allow-list (not used for maintenance) |

Maintenance agentic dreams (`self-orient`, `agentic-housekeeping`) pass:

```text
--disallowed-tools web_search,web_fetch
```

Constant: `MAINTENANCE_DISALLOWED_TOOLS` in `agentic.ts` / argv builder
`disallowedTools` on `buildAmoreHeadlessArgv`.

Also used for maintenance agentic spawns:

| Flag | Role |
|------|------|
| `--always-approve` | Unsupervised tool writes under the house cwd |
| `--max-turns <N>` | Turn wall (action-specific) |
| `--prompt-file` + `--cwd` + `--output-format json` | Standard headless envelope |
| `--no-subagents` | On by default for cost-bounded maintenance |
| `--resume <sessionId>` | Optional multi-leg (verified live on amore 0.2.122) |

## Model path

Binary resolution order (same helper for planner and agentic spawns):

1. Explicit override (tests / multi-install pin)
2. `LUCERNA_AMORE_BIN` (lucerna-specific)
3. `AMORE_BIN` (shared with iris / vinculum and other house tools)
4. `amore` on PATH

No provider SDKs, no API keys, no hardcoded model wire ids in this package.
Optional `--model <entry>` forwards a harness config entry name when the
operator sets one.

Pre-spawn failures (missing binary, ENOENT) do not charge per-action cooldown
or daily/weekly action counters. Those budgets apply once the child process
has started.
