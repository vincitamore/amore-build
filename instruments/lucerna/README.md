# Lucerna

Lucerna is the Amore house steward daemon. It keeps a light heartbeat over a house tree, enforces budgets and default-deny writes, and runs opt-in maintenance actions. Model calls go only through the user's own `amore` configuration via a headless process spawn. There is no network listener and no embedded provider SDK.

## What it does

- **Heartbeat daemon** with phase decay (alert → elevated → resting → drowsy → dreaming).
- **Two-list governance**: protected house identity surfaces are default-deny; only `inbox/captures/`, `forge/`, and lucerna's own runtime state may be written autonomously.
- **Tiered budgets**: 12 actions per day, 6 expensive actions per week, 2 hour cycle cooldown, per-action cooldowns, a soft daily token ceiling of 200_000, and an 80_000-token dreams reserve (auto-commit effective ceiling 120_000). House-local `budgets.json` may raise a cap.
- **Enablement flags** default both off: dreams and live auto-commit require an explicit flip. Dreams-off is not spend-off.
- **Light actions** (model-free or thin shell): `survey-org`, `substrate-health`, `inbox-age-report`, `state-cleanup`, `edges-update`, `qmd-refresh`.
- **Agentic actions** (multi-turn amore, weekly budget): `self-orient`, `agentic-housekeeping`, plus shell densify `edges-densify`.
- **Dreams** (opt-in planner): when `dreamsEnabled` is true, Lucerna may run one planner call per cycle and execute at most one admitted action (light or agentic).
- **Auto-commit dry-run**: drafts a commit message via one headless call on its own 30-minute schedule whether or not dreams are enabled (change-set dedup, token ceiling). Dry-run is a git word: it still spends. Turn it off with `LUCERNA_AUTO_COMMIT=0`. Live mode remains draft-only in this release.

## Install

Lucerna is a Bun package under `instruments/lucerna`. From that directory:

```bash
bun install
bun test
bun run src/cli.ts status --house /path/to/house
```

Optional global-style bin wiring is provided as `lucerna` in `package.json`.

## Configuration

Charter (what the daemon may do) and runtime (what it has done) are different directories. The daemon cannot write charter files.

| Concern | Location |
|---------|----------|
| Charter | `<house>/.amore/lucerna/` (`enable.json`, `budgets.json`, `chores.json`, `governance.user.toml`) |
| Runtime state (health, state, log, sentinels, notifications) | `<house>/instruments/lucerna/` |
| Model entries and credentials | `~/.amore/config.toml` (amore harness) |
| Extra protected paths | `<house>/.amore/lucerna/governance.user.toml` |

Precedence for every spend knob: **`argv > env > file > shipped`**. A house-local `budgets.json` may raise a cap above shipped (`aboveShipped` is visible). Invalid file fields fall back to shipped (no silent clamp). Malformed `chores.json` refuses the cycle.

| File | Absent | Malformed |
|------|--------|-----------|
| `budgets.json` | shipped defaults, no warning | shipped defaults + warning + notice |
| `chores.json` | all shipped chores admitted | refuse the cycle (do not fall back) |
| `enable.json` | dreams off, auto-commit dry-run | same defaults + warning |

Environment overrides (all optional):

- `LUCERNA_HOUSE_ROOT`  -  house root
- `LUCERNA_AMORE_BIN`  -  path to the `amore` binary (wins over `AMORE_BIN`)
- `AMORE_BIN`  -  shared path to the `amore` binary (same as iris / vinculum; used when `LUCERNA_AMORE_BIN` is unset; else `amore` on PATH)
- `LUCERNA_DREAMS_ENABLED=1`  -  enable autonomous dreams (OR with file)
- `LUCERNA_AUTO_COMMIT_LIVE=1`  -  enable live auto-commit flag (OR with file)
- `LUCERNA_MODEL` / `LUCERNA_AUTO_COMMIT_MODEL` / `LUCERNA_DREAM_MODEL`  -  model entry names
- `LUCERNA_DAILY_ACTION_CAP`, `LUCERNA_WEEKLY_EXPENSIVE_CAP`, `LUCERNA_CYCLE_COOLDOWN_HOURS`, `LUCERNA_DAILY_TOKEN_CEILING`, `LUCERNA_DREAMS_RESERVE_TOKENS`
- `LUCERNA_AUTO_COMMIT_COOLDOWN_MINUTES`  -  minimum minutes between auto-commit draft attempts (default 30)
- `LUCERNA_AUTO_COMMIT=0`  -  disable auto-commit drafting entirely (dreams-off does not do this)

## Enablement

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
| `autoCommitEnabled` | `true` when the key is absent | Drafting on or off. `false` is spend-off. |
| `autoCommitLive` | `false` | Live git commit (dry-run — a git word — when false). Ignored when disabled. |

Absent file: dreams off, auto-commit dry-run. Malformed JSON: same defaults, with a log line. An existing file that omits `autoCommitEnabled` keeps drafting. CLI flags and env vars OR with the file for one-shot override. `--no-auto-commit` / `LUCERNA_AUTO_COMMIT=0` win over a file that is on. A legacy `instruments/lucerna/lucerna.enable.json` is still *read* when the charter file is absent; it is never written.

Dreams-off is not spend-off. Turn drafting off with `autoCommitEnabled: false` (`iris lucerna enable auto-commit off`).

## Light dreams

A light dream is one autonomous maintenance cycle: Lucerna gathers a compact house snapshot (org counts, budget counters, recent action history), then makes a single `amore` headless call with a JSON schema that constrains the pick to the admitted action keys or `skip`. At most one action runs per cycle. A `skip` pick writes no report. **Skip is not free**: the planner call still spends tokens on your key. The only way to take no planner spend is to leave dreams off or refuse the cycle before the planner (empty roster, `dailyActionCap` 0, or a budget gate).

Dreams stay **off by default**. Autonomous cycles run only when `dreamsEnabled` is true in `enable.json` (or an equivalent start-time OR of that file with env/CLI). Absent or malformed enablement keeps dreams off. The `wake` sentinel can request an immediate cycle when dreams are already enabled; `sleep` still forces the dreaming heartbeat phase; `halt` requests a graceful stop. Editing or deleting a charter file stops the **next** cycle from starting; `halt` and process stop are the only paths that interrupt work already running.

Budgets apply end to end: 12 actions per day, 6 expensive actions per week, per-action cooldowns, a 2 hour cycle cooldown (1 hour after a zero-action cycle), a soft daily token ceiling of 200_000 that includes the planning call, and an 80_000-token dreams reserve so auto-commit drafts stop at 120_000. The ceiling is soft: a reservation refuses *starting* a planner when remaining room is too small; a call already running can still overshoot. A refused cycle records its reason in `state.json` and the log. `lucerna dream-cycle --force` may override the cycle schedule, but it never overrides enablement and will not run a roster-disabled chore.

Executed light actions write dated reports under `<house>/forge/dreams/` with frontmatter that includes `triggered-by: dream`. Outcomes worth operator attention (action executed, token ceiling, repeated planner failures) append to `<house>/instruments/lucerna/notifications.jsonl` for local surfaces to read.

The only model path is the operator's own `amore` configuration. Lucerna does not embed provider SDKs, API keys, or hardcoded model identifiers.

```bash
lucerna dream-cycle --house ~/my-house          # one cycle if enabled + budgets allow
lucerna dream-cycle --house ~/my-house --force  # ignore schedule only
lucerna dreams -n 10 --house ~/my-house         # recent cycle history from state
lucerna status --house ~/my-house               # includes dream scheduling fields
```

## Agentic dreams

An agentic dream runs a multi-turn `amore` loop so the spawned agent can read the house, use tools, and write dream artifacts. It is not a hardcoded light scan. Agentic actions are **expensive-tier** (weekly budget of 6 by default) and respect every shipped budget, cooldown, and enablement gate.

| Action | Role |
|--------|------|
| `self-orient` | Read orientation surfaces and open state; write a grounded orientation report; propose protected-file updates only |
| `agentic-housekeeping` | Bounded tidy survey (stale refs, unresolved items, doc drift); report-and-propose only |
| `edges-densify` | Shell `iris edges update --tier 2 --json` under dreams budgets (model-judged densify; not a multi-turn loop) |
| `qmd-refresh` | Shell `iris qmd update --embed --json` so the house search index stays current and clears any ingestion backlog (light, daily) |

### What agentic dreams may and may not touch

**May write:** `forge/dreams/` (the report and session manifest Lucerna named), `inbox/captures/`, and Lucerna runtime residual under `instruments/lucerna/` (allow-listed basenames only). Do not write `forge/proposals/` — emit `### Proposal:` blocks in the report; Lucerna materializes one pending file per block. Charter under `.amore/lucerna/` is not writable.

**Must not write:** `AGENTS.md`, `CLAUDE.md`, `context/`, `knowledge/`, `tasks/`, `reminders/`, `tags/`, `graph/`, `projects/`, `archive/`, `scripts/`, `.amore/`, `.grok/`, `.claude/`, or instrument package source. The dream prompt states this boundary. After each agentic cycle Lucerna diffs the house (git porcelain when available, else a file inventory of protected roots). On any out-of-bounds write it logs the breach, appends a `governance-breach` notification, and leaves the dream manifest at `review-status: pending` with the breach named in the body. Lucerna does not auto-revert.

### Enablement, budgets, wall-timeout, web-off

- **Enablement default: OFF.** Agentic cycles run only when `dreamsEnabled` is true. `--force` never flips enablement.
- **Budgets:** same daily action cap and soft token ceiling as light dreams; agentic keys also consume the weekly expensive budget and the 12 hour recipe cooldown.
- **Wall-timeout:** every agentic spawn has a configurable wall (default 20 minutes via `LUCERNA_AGENTIC_WALL_MS`). On expiry the driver kills the entire process tree (Windows `taskkill /T /F`, Unix process-group kill).
- **Web access off:** maintenance agentic dreams pass `--disallowed-tools web_search,web_fetch` to the amore CLI (verified against the pager flag surface; see `src/engine/dispatch-contract.md`).
- **Model path:** only the operator's own `amore` configuration. No provider SDKs, API keys, or hardcoded model ids inside Lucerna.

### Manifests and proposals

| Artifact | Path | Notes |
|----------|------|-------|
| Dream manifest | `forge/dreams/sessions/<YYYYMMDD-HHmmss>-<action>.manifest.md` | Frontmatter includes `type: forge`, `pipeline: dream-<action>`, `recipe: dream`, `triggered-by: dream`, `review-status: pending` (this is the review handle) |
| Agentic report | `forge/dreams/<ts>-<action>.md` | Same `pipeline: dream-<action>` and `recipe: dream` as the manifest; no `status: pending` (pipeline artifact, not a queue item) |
| Light report | `forge/dreams/<ts>-<action>.md` | Wave-2 shape: `status: pending`, `dream-action`, `triggered-by: dream` (no pipeline field) |
| Proposal | `forge/proposals/<slug>.md` | `type: proposal`, `status: pending`, `triggered-by: dream`; never auto-applied |

A resident agent reviews manifests (`review-status: pending` → `reviewed`) and applies or closes proposals (`status: pending` → `applied` or `closed`). House skill: `.amore/skills/somniator/SKILL.md` in the house template.

```bash
lucerna dream-cycle --house ~/my-house --action self-orient --force
lucerna dreams -n 10 --house ~/my-house
lucerna status --house ~/my-house   # agentic keys, wall, web-off posture
```

## File-based control surface

Charter under `<house>/.amore/lucerna/`:

| File | Role |
|------|------|
| `enable.json` | durable enablement knobs |
| `budgets.json` | spend caps (file may raise; `aboveShipped` is visible) |
| `chores.json` | narrowing chore roster |
| `governance.user.toml` | additive protected paths only |

Runtime under `<house>/instruments/lucerna/`:

| File | Role |
|------|------|
| `health.json` | pid, startedAt, lastBeat, version, heartbeat phase |
| `state.json` | activity, last action results, budget counters, auto-commit draft |
| `log` | append-only plaintext log |
| `halt` | write then delete-on-consume; graceful stop |
| `wake` | write then delete-on-consume; stimulate heartbeat |
| `sleep` | write then delete-on-consume; force dreaming phase |
| `notifications.jsonl` | append-only operator attention queue |

Example:

```bash
lucerna start --house ~/my-house
echo > ~/my-house/instruments/lucerna/halt   # request stop (does not interrupt a running cycle)
lucerna status --house ~/my-house
lucerna dream survey-org --house ~/my-house
lucerna dream-cycle --house ~/my-house
lucerna dreams -n 10 --house ~/my-house
lucerna log -n 50 --house ~/my-house
lucerna smoke --house /tmp/synthetic-house
```

## Governance

Shipped **protected** (relative to house root): `AGENTS.md`, `CLAUDE.md`, `context/`, `knowledge/`, `tasks/`, `reminders/`, `tags/`, `graph/`, `projects/`, `archive/`, `scripts/`, `.amore/`, `.grok/`, `.claude/`, `instruments/`.

Shipped **writable**: `inbox/captures/`, `forge/`, plus residual allow-listed files under `instruments/lucerna/` (runtime only, not package source, not charter).

Users may add protected paths via `.amore/lucerna/governance.user.toml`:

```toml
protected_extra = ["secrets/", "private/"]
```

User entries never remove shipped protection and never widen the writable set.

## Security

Lucerna does not open a network port. Control is local files only. The only path to a model is spawning the `amore` binary the operator already configured (auth, provider routing, and model ids live in that harness). There are no API keys in lucerna, no provider SDKs, and no hardcoded model identifiers. Autonomous dreams and live commits stay off until the operator enables them. All autonomous writes pass a shared write guard against the governance lists.

## Development

```bash
bun install
bun test
bun run typecheck
bun run src/cli.ts smoke
```

Tests use synthetic temp houses and spawn stubs. They never require network access or a configured model.
