# House hooks pack

First-class cooperation-harness hooks shipped with every house created by
`selene init`. They are not optional extras — they close the turn and orient
the session.

| File | Event | Role |
|------|-------|------|
| `house-stop-gate.json` + `bin/house_stop_gate.py` | `Stop` | Turn-end maintenance vigilance gate |
| `house-session-init.json` + `bin/house_session_init.py` | `SessionStart` | Due-reminder surface + orientation pointer |

Windows shims (`*.cmd`) sit next to the Python scripts so the hook runner can
spawn them via `CreateProcess` without shell metacharacters.

## Stop gate

Reads the Stop envelope on stdin. Emits nothing + exit 0 to release; emits
`{"decision":"block","reason":"..."}` to feed a maintenance checklist back to
the model. Decision logic:

- once per operator turn (session-scoped state under `~/.selene/state/stop-gate/`,
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

## Branch tests

Canned envelopes live under `fixtures/stop-gate/` and `fixtures/session-init/`
with path placeholders (`__HOUSE__`, `__BUSY_TRANSCRIPT__`, …). Materialize and
drive them:

```bat
python bin\run_branch_tests.py
```

The runner builds tempfile houses/transcripts, substitutes placeholders, then
pipes each envelope exactly as:

```bat
type <materialized>.json | python bin\house_stop_gate.py
type <materialized>.json | python bin\house_session_init.py
```

(cwd = this hooks directory; from `templates/house` prefix with `.selene\hooks\`).
