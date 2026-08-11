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
listener**. Control stays file-based under
`<house>/instruments/lucerna/`.

Iris can observe and operate Lucerna through a loopback file proxy
(`127.0.0.1:3853`) without giving Lucerna a second listener. That surface is
documented in [iris-lucerna.md](iris-lucerna.md).

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

File: `<house>/instruments/lucerna/lucerna.enable.json`

```json
{
  "dreamsEnabled": false,
  "autoCommitLive": false
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `dreamsEnabled` | `false` | Autonomous dream scheduling |
| `autoCommitLive` | `false` | Live auto-commit; dry-run when false |

**Absent file: both false.** Malformed JSON: both false (with a log line).
CLI flags (`--dreams-enabled`, `--auto-commit-live`) and env vars
(`LUCERNA_DREAMS_ENABLED=1`, `LUCERNA_AUTO_COMMIT_LIVE=1`) OR with the file
for one-shot override. Safe defaults never flip themselves on.

Auto-commit drafting may still run on its own schedule when auto-commit is
not fully disabled (`LUCERNA_AUTO_COMMIT=0` or `--no-auto-commit` turns it
off). With `autoCommitLive` false, drafts are dry-run only. Live mode
remains draft-only until a hardened live path ships; treat live as "not a
silent git commit" regardless of the flag name.

---

## Governance (default-deny, two lists)

Writes are allowed only when the path matches **writable** and does not
match **protected**. Paths outside the house root are always protected.

### Never writable autonomously (shipped protected)

`AGENTS.md`, `CLAUDE.md`, `context/`, `knowledge/`, `tasks/`, `reminders/`,
`tags/`, `graph/`, `projects/`, `archive/`, `scripts/`, `.amore/`, `.grok/`,
`.claude/`, `instruments/` (with residual write only for Lucerna runtime
files under `instruments/lucerna/`, not package source).

### Shipped writable

`inbox/captures/`, `forge/`.

### User extension (`protected_extra`)

```toml
# <house>/instruments/lucerna/governance.user.toml
protected_extra = ["secrets/", "private/"]
```

User entries are **additive only**. They never remove shipped protection and
never widen the writable set.

All autonomous writers call a shared write guard before creating files.

---

## Budgets and ceilings

| Cap | Shipped default |
|-----|-----------------|
| Actions per calendar day | 12 |
| Expensive (recipe / agentic) actions per ISO week | 6 |
| Cycle cooldown | 2 hours (1 hour short cooldown after a zero-action cycle) |
| Light-action cooldown | 24 hours per action key |
| Recipe / agentic cooldown | 12 hours per action key |
| Soft daily token ceiling | 200_000 tokens from driver usage envelopes |

Operator overrides (env): `LUCERNA_DAILY_ACTION_CAP`,
`LUCERNA_WEEKLY_EXPENSIVE_CAP`, `LUCERNA_CYCLE_COOLDOWN_HOURS`,
`LUCERNA_DAILY_TOKEN_CEILING`. A refused cycle records its reason in
`state.json` and the activity log.

---

## Dream classes

### Light dreams (model-free actions + one planner call)

When `dreamsEnabled` is true, Lucerna may run one planner call per cycle and
execute at most one admitted light action (`survey-org`, `substrate-health`,
`inbox-age-report`, `state-cleanup`) or skip. Light actions themselves do not
call a model; the planner pick does, through `amore` headless. Reports land
under `forge/dreams/` with frontmatter including `triggered-by: dream`.

`lucerna dream-cycle --force` may override the cycle schedule only. It never
overrides enablement.

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
| Lucerna has no listener | no bind in package; control is files under `instruments/lucerna/` |
| Iris is loopback only | [ports.md](ports.md); default `127.0.0.1:3853` |
| Model traffic uses operator config only | [egress.md](egress.md); capture scripts below |
| No daemon-owned provider endpoints | no SDK/keys/model ids in Lucerna sources |
| Version check is kill-switchable | `AMORE_UPDATE_CHECK=0` or `AMORE_DISABLE_UPDATES=1`; see [egress.md](egress.md) |

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

| Action | Effect |
|--------|--------|
| `echo > <house>/instruments/lucerna/halt` or `iris lucerna halt` | request graceful stop |
| `iris lucerna stop` / tab `k` | halt, then pid-verified kill if still alive |
| Set `dreamsEnabled` to `false` | autonomous dreams stop |
| Delete or break `lucerna.enable.json` | both knobs false |
| `LUCERNA_AUTO_COMMIT=0` | auto-commit drafting off |
| Remove binary / uninstall companion | nothing left to schedule |

`sleep` and `wake` sentinels only affect heartbeat phase and cycle timing;
they do not invent enablement. `wake` can request an immediate cycle only
when dreams are already enabled.

---

## Operator checklist

1. Confirm Lucerna was installed only if `--with-lucerna` was used.
2. Read `lucerna.enable.json` (or confirm it is absent).
3. Read `governance.user.toml` if present; know your `protected_extra` list.
4. Run `lucerna status --house <house>` (or `iris lucerna status`) and confirm
   dreams OFF unless you flipped them.
5. On Linux, run `scripts/lucerna_egress_capture.sh` against your own config
   and require PASS with only configured host / DNS / local endpoints.
6. Know the halt path before enabling dreams on a shared machine.
