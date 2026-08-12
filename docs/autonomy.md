# Autonomy: Lucerna defaults an operator can verify

This page is the autonomy story for a skeptical operator. Every default below
is either a file you can open, a flag you can omit, or a capture script you
can run. Product claims that contradict these defaults are bugs: report them
via the [security policy](../SECURITY.md).

**Related pages:** [egress inventory and capture](egress.md) ·
[iris Lucerna surface](iris-lucerna.md) · [loopback ports](ports.md) ·
[SECURITY.md](../SECURITY.md)

---

## What Lucerna is

**Lucerna** is the house steward daemon. It keeps a light heartbeat over a
house tree, enforces budgets and default-deny writes, and runs **opt-in**
maintenance actions. Model calls go only through the operator's own `amore`
configuration via a headless process spawn. Lucerna embeds no provider SDK,
no API keys, and no hardcoded model identifiers. It opens **no network
listener**.

Control is file-based, in two directories:

| Directory | Role |
|-----------|------|
| `<house>/.amore/lucerna/` | Charter — what the daemon **may do** (`enable.json`, `budgets.json`, `chores.json`, `governance.user.toml`). The daemon cannot write here. |
| `<house>/instruments/lucerna/` | Runtime — what the daemon **has done** (health, state, log, notifications, sentinels). |

Iris can observe and operate Lucerna through a loopback file proxy
(`127.0.0.1:3853`) without giving Lucerna a second listener. That surface is
loopback-unauthenticated. Documented in [iris-lucerna.md](iris-lucerna.md).

Per-house caps do not sum to a machine cap. Several houses sharing one API
key each have their own ceilings.

---

## Opt-in at install

| Companion | `amore init` default |
|-----------|----------------------|
| iris | **on** (opt out with `--no-iris`) |
| Lucerna | **off** (opt in with `--with-lucerna`) |
| Speculum | **off** (opt in with `--with-speculum`) |

Without `--with-lucerna`, init does not fetch a Lucerna binary. Starting
autonomy requires both install and a later enablement flip.

---

## Enablement defaults

File: `<house>/.amore/lucerna/enable.json`

```json
{
  "dreamsEnabled": false,
  "autoCommitEnabled": true,
  "autoCommitLive": false
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `dreamsEnabled` | `false` | Autonomous dream scheduling |
| `autoCommitEnabled` | `true` when the key is absent | Whether auto-commit may draft at all. `false` is spend-off: no model call, no tokens. |
| `autoCommitLive` | `false` | Live auto-commit; dry-run (git word: draft only, no commit) when false. Ignored when disabled. |

**Absent file:** dreams off, auto-commit dry-run (the v1.0.1 default).
Malformed JSON: same defaults (with a log line). An existing file that
omits `autoCommitEnabled` keeps drafting. CLI flags
(`--dreams-enabled`, `--auto-commit-live`, `--no-auto-commit`) and env
vars (`LUCERNA_DREAMS_ENABLED=1`, `LUCERNA_AUTO_COMMIT_LIVE=1`,
`LUCERNA_AUTO_COMMIT=0`) OR with the file for one-shot override.
`--no-auto-commit` / `LUCERNA_AUTO_COMMIT=0` win over a file that is on.
A file edit does not revoke an env/argv enablement.

If the charter file is absent and a legacy
`<house>/instruments/lucerna/lucerna.enable.json` exists, that file is
still *read*. It is never written.

**Dreams-off is not spend-off.** Auto-commit drafting runs on its own
schedule (default 30 minutes) against your configured model and key
unless `autoCommitEnabled` is false (tab `a` to off, or
`iris lucerna enable auto-commit off`). Dry-run means "do not commit,"
not "do not call a model." `LUCERNA_AUTO_COMMIT=0` and `--no-auto-commit`
remain start-time kills. Live mode remains draft-only until a hardened
live path ships; treat live as "not a silent git commit" regardless of
the flag name.

---

## Governance (default-deny, two lists)

Writes are allowed only when the path matches **writable** and does not
match **protected**. Paths outside the house root are always protected.

### Never writable autonomously (shipped protected)

`AGENTS.md`, `CLAUDE.md`, `context/`, `knowledge/`, `tasks/`, `reminders/`,
`tags/`, `graph/`, `projects/`, `archive/`, `scripts/`, `.amore/` (including
charter), `.grok/`, `.claude/`, `instruments/` (package and instrument
source). Residual write is an **allow-list** of Lucerna runtime basenames
under `instruments/lucerna/` only: `health.json`, `state.json`, `log`,
`notifications.jsonl`, `daemon.pid`, `halt`, `wake`, `sleep`, plus write
artifacts (`log.N`, `*.tmp`, `draft-*`). Enablement and user-governance
files are not on that list.

These lists bound **writes**, not reads.

### Shipped writable

`inbox/captures/`, `forge/`.

### User extension (`protected_extra`)

```toml
# <house>/.amore/lucerna/governance.user.toml
protected_extra = ["secrets/", "private/"]
```

User entries are **additive only**. They never remove shipped protection and
never widen the writable set. A user extra outranks the residual allow-list.

All autonomous writers call a shared write guard before creating files.

---

## Budgets and ceilings

File: `<house>/.amore/lucerna/budgets.json`. Absent file → shipped defaults,
no warning. Malformed file → shipped defaults, a warning, and a
`charter-malformed` notice; the panel still renders. The daemon never
writes this file.

Precedence for every knob: **`argv > env > file > shipped`**. Each resolved
knob carries `source` (`shipped` / `file` / `env` / `argv`) and
`aboveShipped`. The file **may** raise a cap above the shipped default;
surfaces show `aboveShipped` when that happens.

| Cap | Shipped default | Notes |
|-----|-----------------|-------|
| Actions per calendar day (`dailyActionCap`) | 12 | `0` is an explicit disable (daemon may run, takes no actions). Rendered "disabled (cap 0)", never `0/0`. |
| Expensive (recipe / agentic) actions per ISO week | 6 | Resets on the ISO week. |
| Cycle cooldown | 2 hours | File floor 30 minutes. **1 hour short cooldown** after a zero-action cycle (wired: all-disabled / cap-0 pre-planner refusal, and any completed cycle that took no catalog action). |
| Light-action cooldown | 24 hours per action key | Compile-time class floor; roster may only lengthen. |
| Recipe / agentic cooldown | 12 hours per action key | Same lengthen-only rule. |
| Soft daily token ceiling | 200_000 tokens from driver usage envelopes | Soft: a running call can overshoot. `0` disables spend. |
| Dreams reserve (`dreamsReserveTokens`) | 80_000 | Auto-commit effective ceiling is `dailyTokenCeiling − reserve` (shipped: **120_000**). Dreams test the full ceiling. Reserve ≥ ceiling is invalid → that field falls back to shipped. |

Capability on the snapshot (composed with Running; never a fifth liveness
state): **`ready` | `cooling` | `refusing`**, plus a named `reasonCode`
(`token-ceiling`, `daily-cap`, `cooldown`, `config-invalid`,
`roster-empty`, `cap-zero`).

Token counters: one `tokensToday`, equal to the sum of
`tokensTodayBySource` (`planner`, `agentic`, `autoCommit`) when the map is
present. Auto-commit drafts refuse at `ceiling − reserve` while dreams may
still start. A planner call is not started unless `tokensToday` plus a
reservation room fits the dreams ceiling. That states the overshoot bound;
it is not a hard per-call limit.

Operator overrides (env): `LUCERNA_DAILY_ACTION_CAP`,
`LUCERNA_WEEKLY_EXPENSIVE_CAP`, `LUCERNA_CYCLE_COOLDOWN_HOURS`,
`LUCERNA_DAILY_TOKEN_CEILING`, `LUCERNA_DREAMS_RESERVE_TOKENS`,
`LUCERNA_AUTO_COMMIT_COOLDOWN_MINUTES`. Invalid integer forms (`1e9`,
`200_000`) are rejected and that field stays at shipped. A refused cycle
records its reason in `state.json` and the activity log.

Edit the three integer caps from the Lucerna tab (`b`) or
`iris lucerna budgets set <cap> <value>`. Cooldown knobs are CLI-only.
Changes apply at the next cycle.

## Chore roster

File: `<house>/.amore/lucerna/chores.json`. The user-facing noun is
**chores**. The roster **narrows**; it cannot invent a key the build does
not ship, and it cannot change spawn flags (tools, wall, turns, model,
subagents, budget class, governance paths). Unlisted keys, an absent file,
or an absent `enabled` field mean **enabled**. Unknown keys and unknown
entry fields are ignored. Malformed roster JSON refuses the cycle (falling
back to "everything admitted" would widen).

Admitted fields per entry: `enabled`, `minIntervalHours`. Interval is
lengthen-only against the compiled class floor.

`--force` / `--action <key>` will not run a chore the roster has disabled.
Open the overlay with `c`; toggle a row with `t`. CLI:
`iris lucerna chores list|show|enable|disable|interval`.

---

## Dream classes

### Light dreams (model-free actions + one planner call)

When `dreamsEnabled` is true, Lucerna may run one planner call per cycle and
execute at most one admitted light action (`survey-org`, `substrate-health`,
`inbox-age-report`, `state-cleanup`, `edges-update`, `qmd-refresh`) or skip.
Light actions themselves do not call a model; the planner pick does, through
`amore` headless. A `skip` still spends that planner call. Reports land
under `forge/dreams/` with frontmatter including `triggered-by: dream`.

`lucerna dream-cycle --force` may override the cycle schedule only. It never
overrides enablement, and it will not run a roster-disabled chore.

### Agentic maintenance dreams

When enabled, agentic maintenance dreams may spawn longer headless `amore`
runs (still under wall-timeout kill and governance). They write:

- **Session manifests** under `forge/dreams/sessions/` with
  `triggered-by: dream` and `review-status: pending` until a human flips
  review status.
- **Proposals only** (never auto-applied) under `forge/proposals/` when a
  change would touch a path the daemon may not write.

Graph refresh shells to `iris edges update` (tier 0 structural without a
model; tier 2 model-judged edges require a working `amore` binary). There
is no before-the-fact approval gate on derived edges; stewardship is
after-the-fact (`iris edges list/show/edit/remove` plus suppressions).

### Iris qmd index freshness

When the iris daemon is running and a managed qmd house index exists, the
daemon debounce-batches markdown changes under the org sections into a
serialized local `qmd update` (and a bounded embed pass only when embedding
models are already on disk). That path is a local subprocess with no
network: model downloads remain an explicit setup step, never a background
pull. Operators can inspect last refresh time and pending change counts with
`iris qmd status`. Disable automatic refresh with `IRIS_QMD_NO_REFRESH=1`.

### Maintenance tool restriction

Maintenance dream spawns that reach a model are expected to disable web
tools on the `amore` CLI. Verified flag names on the shipped harness:

- `--disable-web-search`
- `--disallowed-tools` with `web_search` and `web_fetch` (and related names)

Light-dream planner calls already pass `--no-subagents` and a wall timeout.
Interactive sessions the operator starts remain free to use tools; that is
workload traffic, not the daemon claim.

---

## Wall-timeout kill

Every Lucerna-driven `amore` spawn carries a wall-clock timeout. On expiry
the **entire process tree** is killed:

- Windows: `taskkill /T /F /PID …`
- POSIX: process-group kill when the child was detached, else signal the
  child

Default headless wall is 240 seconds. Light-dream planner calls use 180
seconds. A timeout is a failed action, not a hang.

---

## Network and model path

| Claim | How to verify |
|-------|----------------|
| Lucerna has no listener | no bind in package; charter under `.amore/lucerna/`; runtime under `instruments/lucerna/` |
| Iris is loopback only | [ports.md](ports.md); default `127.0.0.1:3853` |
| Model traffic uses operator config only | [egress.md](egress.md); capture scripts below |
| No daemon-owned provider endpoints | no SDK/keys/model ids in Lucerna sources |
| Version check is kill-switchable | `AMORE_UPDATE_CHECK=0` or `AMORE_DISABLE_UPDATES=1`; see [egress.md](egress.md) |
| Version apply is never unattended | Apply requires `amore update` or Ctrl+U; compiled default `cli.auto_update` is false; the inherited upstream hourly install loop is hard-off (`FORK_AUTO_UPDATE_HARD_OFF`); background path is check-only (24h cadence) |

Capture scripts (Linux + strace):

```bash
# One headless amore prompt
scripts/egress_capture.sh ~/.local/bin/amore ~/.amore/config.toml <model-entry>

# One lucerna dream cycle (dreams on in a scratch house, auto-commit dry-run)
scripts/lucerna_egress_capture.sh \
  ~/.local/bin/lucerna ~/.local/bin/amore \
  ~/.amore/config.toml <model-entry>
```

Non-Linux hosts exit with an honest message; the method is not emulated.

---

## Disable and kill paths

Editing or deleting a charter file (`enable.json`, `budgets.json`,
`chores.json`, `governance.user.toml`) stops the **next** cycle from
starting. The `halt` sentinel and process stop are the only paths that
interrupt work already running. Deleting a file does not stop a cycle that
is already in flight.

| Action | Effect | Scope |
|--------|--------|-------|
| `echo > <house>/instruments/lucerna/halt` or `iris lucerna halt` | request graceful stop | current unit finishes; next unit does not start |
| `iris lucerna stop` / tab `k` | halt, then pid-verified kill if still alive | **immediate** after halt timeout |
| Set `dreamsEnabled` to `false` | autonomous dreams will not start | **next cycle** (file edit does not revoke env/argv) |
| Delete or break `enable.json` | dreams off, auto-commit dry-run | **next cycle** |
| Edit or delete `budgets.json` / `chores.json` | new caps / roster take effect | **next cycle** (or next auto-commit draft attempt) |
| `LUCERNA_AUTO_COMMIT=0` | auto-commit drafting off | **next draft attempt** |
| Remove binary / uninstall companion | nothing left to schedule | **immediate** (no process) |

`sleep` and `wake` sentinels only affect heartbeat phase and cycle timing;
they do not invent enablement. `wake` can request an immediate cycle only
when dreams are already enabled.

---

## Operator checklist

1. Confirm Lucerna was installed only if `--with-lucerna` was used.
2. Read `.amore/lucerna/enable.json` (or confirm it is absent).
3. Read `.amore/lucerna/budgets.json` and `.amore/lucerna/chores.json`
   (the roster). Know which chores are enabled and which caps are
   `aboveShipped`.
4. Read `.amore/lucerna/governance.user.toml` if present; know your
   `protected_extra` list.
5. Run `lucerna status --house <house>` (or `iris lucerna status` /
   `iris lucerna budgets`) and confirm dreams OFF unless you flipped them.
6. On Linux, run `scripts/lucerna_egress_capture.sh` against your own config
   and require PASS with only configured host / DNS / local endpoints.
7. Know the halt / stop path (and its scope) before enabling dreams on a
   shared machine.
