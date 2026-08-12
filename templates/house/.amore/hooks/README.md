# House hooks pack

First-class cooperation-harness hooks shipped with every house created by
`amore init`. They are not optional extras — they close the turn, orient
the session, and re-point at disk across a compact boundary.

| File | Event | Role |
|------|-------|------|
| `house-stop-gate.json` + `bin/house_stop_gate.py` | `Stop` | Turn-end maintenance vigilance gate |
| `house-session-init.json` + `bin/house_session_init.py` | `SessionStart` | Due-reminder surface + orientation pointer |
| `house-compact.json` + `bin/house_compact.py` | `PreCompact` / `PostCompact` | Disk-orientation packet at the compact boundary |

Windows shims (`*.cmd`) sit next to the Python scripts so the hook runner can
spawn them via `CreateProcess` without shell metacharacters.

## Stop gate

Reads the Stop envelope on stdin. Emits nothing + exit 0 to release; emits
`{"decision":"block","reason":"..."}` to feed a maintenance checklist back to
the model. Decision logic:

- once per operator turn (session-scoped state under `~/.amore/state/stop-gate/`,
  keyed by `promptId`);
- line-anchored release phrases (`No maintenance needed`, `Maintenance complete`,
  `Gate released`, …) or a capture-path write in this turn releases;
- trivial sessions (< 3 work signals) and non-house workspaces (no
  `AGENTS.md`-class marker + `tasks/`) never fire;
- only `reason == "end_turn"` is gated — session-end observe fires release;
- fail-open on parse/IO errors.

## Session-init

Runs on `SessionStart`. When the workspace is a house and one or more
`reminders/**/*.md` files are due (`status: pending|snoozed` and
`remind-at`/`snoozed-until` ≤ now), emits:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
```

Context lists due reminders and a one-line orientation pointer
(`AGENTS.md → context/current-state.md → active task`). Silent success
(empty stdout, exit 0) when nothing is due or the cwd is not a house.
Python stdlib only, <5s budget, fail-open.

Wire format matches the hook vocabulary in the product user guide
(`10-hooks.md`: SessionStart event, common envelope fields, and the
`hookSpecificOutput.additionalContext` shape documented under Stop Decision
Control).

## Compact

Runs on `PreCompact` and `PostCompact`. When the workspace is a house,
always emits (unlike session-init, which is silent when nothing is due):

```json
{"hookSpecificOutput":{"hookEventName":"PostCompact","additionalContext":"..."}}
```

PreCompact frames a disk snapshot for the summarizer. PostCompact frames
the orientation packet: re-read `context/current-state.md` → the active
task → named tips; the summary is forensics, not warrant. Pointers only
— no body dumps, no tip-write (a hook cannot update the task file).

The harness currently discards compact `additionalContext` (SessionStart
is the consume pattern). The emit is the contract so a later consume
path can land without changing this script.

Python stdlib only, <5s budget, fail-open. Silent on non-house cwd or a
wrong event.

## Branch tests

Canned envelopes live under `fixtures/stop-gate/`, `fixtures/session-init/`,
and `fixtures/compact/` with path placeholders (`__HOUSE__`,
`__HOUSE_WITH_ACTIVE__`, `__BUSY_TRANSCRIPT__`, …). Materialize and
drive them:

```bat
python bin\run_branch_tests.py
```

The runner builds tempfile houses/transcripts, substitutes placeholders, then
pipes each envelope exactly as:

```bat
type <materialized>.json | python bin\house_stop_gate.py
type <materialized>.json | python bin\house_session_init.py
type <materialized>.json | python bin\house_compact.py
```

(cwd = this hooks directory; from `templates/house` prefix with `.amore\hooks\`).
