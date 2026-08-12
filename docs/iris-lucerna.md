# Iris Lucerna surface

**Lucerna** is the house steward daemon. Iris exposes a loopback file proxy and
dash tab so the operator can observe and operate Lucerna without a second network
listener. Charter (what the daemon may do) lives under
`<house>/.amore/lucerna/`. Runtime (what it has done) lives under
`<house>/instruments/lucerna/`. Iris on loopback is unauthenticated.

This page documents the iris side: the dash tab, CLI verbs, start/stop
semantics, enablement flags, and the shared file contract. Package sources live
under [`instruments/iris/`](../instruments/iris/) (proxy, routes, TUI, CLI) and
[`instruments/lucerna/`](../instruments/lucerna/) (the steward process).

The Lucerna tab, live against a running steward:

![Lucerna tab](assets/iris/lucerna.png)

The Dashboard Pulse carries a Lucerna row with the daemon state and its most
recent outcome:

![Dashboard with Lucerna pulse row](assets/iris/dashboard.png)

---

## Dash tab

The Lucerna tab is the eighth member in the iris dash (hotkey `8` in the
Dashboard … Lucerna … Graph order; bar shows `1`–`9`). It is honest at every
state:

| State | What the tab shows |
|-------|--------------------|
| Iris daemon down | Quiet notice; no poll |
| Not installed | Explainer and install hint (`amore init --with-lucerna`) |
| Stopped | Runtime dir present, no live heartbeat |
| Running | Fresh beat, **live budgets**, enablement, log, notifications. Capability (`ready` / `cooling` / `refusing`) is composed with Running — refusing is not a fifth liveness state. The Activity value stays `Running`; the sub carries `refusing · resumes HH:MM` when the daemon is refusing. |
| Stale / hung | Available but beat older than two heartbeat intervals |

Budgets panel empty states (distinct; never a single `—`):

| Condition | What you see |
|-----------|----------------|
| No state / daemon never ran | `no cycle has run yet · caps shipped at 12/day, 6/week, 200K tokens` |
| State present, budgets snapshot missing or unparseable | `budgets unavailable — restart Lucerna to populate` |
| Counters all zero | normal gauge rows `0/12`, `0/6`, `0/200K` |

Hint line: `b edit caps · c chores`.

### Keys

| Key | Action |
|-----|--------|
| `r` | Start Lucerna (detached spawn via the iris daemon proxy) |
| `k` | Stop (confirm): halt sentinel, then pid kill only if still alive |
| `h` | Halt sentinel only (confirm) |
| `w` | Wake sentinel |
| `s` | Sleep sentinel |
| `d` | Toggle dreams enablement (confirm — UX, not auth) |
| `a` | Toggle auto-commit live vs dry-run (confirm) |
| `b` | Edit a spend cap (actions / expensive / tokens); confirm, then applies at the next cycle |
| `c` | Open the chores overlay (roster) |
| `t` | (chores overlay) toggle the selected chore (confirm) |
| `p` | Focus the Review panel (dreams + proposals) |
| arrows / PgUp / PgDn | Scroll the activity log (or navigate Review / chores when focused) |
| Enter (Review) | Open the detail **overlay** (list stays in the panel) |
| `v` (Review / overlay) | Confirm: mark dream reviewed / proposal applied (status only) |
| `x` (Review / overlay) | Confirm: close a pending proposal (status only) |
| Esc | Close overlay, or leave Review focus |

Detail opens a centered overlay (most of the screen, scrollable with ↑↓ /
PgUp / PgDn). Markdown is rendered lightly (headings, lists, code). An agentic
session manifest that has a linked `forge/dreams/` report shows **one** list
row; the overlay includes the report under a “Linked report” heading.

![Reading overlay on a dream manifest](assets/iris/lucerna-overlay.png)

Enablement toggles always re-read the file after write so the badges show the
on-disk truth, not a local guess.

### Launch with Lucerna focused

Open the dash on the Lucerna tab:

```sh
iris dash --member Lucerna
# or
IRIS_MEMBER=Lucerna iris
```

`IRIS_TAB` is accepted as an alias for `IRIS_MEMBER`. Names match the tab bar
case-insensitively.

---

## CLI verbs

All verbs go through the iris daemon at `127.0.0.1` (default port 3853):

```sh
iris lucerna status
iris lucerna log [--n N] [--filter SUBSTR]
iris lucerna notifications [--n N]
iris lucerna start
iris lucerna stop
iris lucerna halt
iris lucerna wake
iris lucerna sleep
iris lucerna enable dreams on|off
iris lucerna enable auto-commit-live on|off
iris lucerna budgets [show]
iris lucerna budgets set <cap> <value>
iris lucerna chores [list|show <key>]
iris lucerna chores enable|disable <key>
iris lucerna chores interval <key> <hours>
iris lucerna dreams [--pending]
iris lucerna dreams show <id>
iris lucerna dreams review <id>
iris lucerna proposals [--pending]
iris lucerna proposals show <id>
iris lucerna proposals apply <id>
iris lucerna proposals close <id>
```

Write verbs exit non-zero when the proxy reports `ok: false` (for example
Lucerna not installed, no binary to start, or stop kill refused).

The iris CLI matches at most three words for a command name (longest match
first), so `show` / `review` / `apply` / `close` / `set` / `enable` /
`disable` / `interval` are their own specs under `lucerna dreams`,
`lucerna proposals`, `lucerna budgets`, and `lucerna chores`. Reads of a
not-installed house exit 0; write refusals exit 1.

---

## Dream and proposal review loop

Agentic dream cycles write house artifacts that the operator reviews here (the
Lucerna writer never auto-applies proposal content):

| Artifact | Path | Review field |
|----------|------|--------------|
| Session manifest | `forge/dreams/sessions/<id>.manifest.md` | `review-status: pending \| reviewed` |
| Light dream report | `forge/dreams/<name>.md` | `status: pending \| acted` |
| Proposal | `forge/proposals/<slug>.md` | `status: pending \| applied \| closed` |

Listing is kind-tagged (manifest vs light vs proposal), **pending first**, then
newest `created` first. Partial or older frontmatter degrades field-by-field
(missing fields show as absent; non-`.md` files are skipped). Review verbs flip
**exactly one** frontmatter field with an atomic temp+rename write and refuse
when the current value is not the expected pre-state. Proposal `apply` / `close`
change status only; applying the **content** of a proposal remains the
resident or operator's work (the CLI says so in its output).

Honest empty states:

| Situation | What you see |
|-----------|----------------|
| No artifacts yet | Empty Review panel / empty list payload |
| Dreams disabled | Enablement badge off; empty copy notes dreams are disabled |
| Lucerna not installed | Ops cards explain install; Review still lists house forge files when present |

The Review panel focused, with pending artifacts listed:

![Lucerna Review panel](assets/iris/lucerna-review.png)

---

## Start and stop semantics

### Start (`iris lucerna start` / tab `r`)

The iris daemon resolves a Lucerna entrypoint, spawns it as a **detached** child
with **unref** so the process survives iris exiting, then polls `health.json`
for a live beat (bounded wait; never open-ended).

**Binary resolution order:**

1. Environment `IRIS_LUCERNA_BIN` (executable or `.ts`/`.js` entry script)
2. `lucerna` binary on `PATH`
3. House/repo layout: `bun` against `instruments/lucerna` (`src/cli.ts` or
   package start) with `--house <orgRoot>`

Spawn cwd is the house root (or the package directory for the repo layout).
House root is also passed as `LUCERNA_HOUSE_ROOT`. Outcomes are distinct:
`started`, `already-running`, `no-binary`, `timeout`, `not-installed`,
`spawn-failed`.

### Stop (`iris lucerna stop` / tab `k`)

1. Prefer the graceful path: write the `halt` sentinel, wait bounded for the
   heartbeat to stop (or the pid to exit).
2. On timeout only: re-read `pid` from `health.json`, verify that pid still
   names a **lucerna** process (command line contains `lucerna`), then kill
   **by pid**. Iris never kills by process name alone.
3. Outcomes are distinct: `halted` (graceful), `killed` (escalated),
   `already-stopped`, `kill-refused` (pid not lucerna), `still-running`.

`iris lucerna halt` writes only the sentinel without the wait/escalate loop.

---

## Enablement flags

File: `<house>/.amore/lucerna/enable.json`

```json
{
  "dreamsEnabled": false,
  "autoCommitLive": false
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `dreamsEnabled` | `false` | Autonomous dream scheduling |
| `autoCommitLive` | `false` | Live auto-commit (dry-run — a git word — when false) |

Absent or malformed file: both false. Iris writes the charter path
(write-temp-rename). A legacy
`<house>/instruments/lucerna/lucerna.enable.json` is still *read* when the
charter file is absent; it is never written. CLI and TUI always display the
file values after each change.

Dreams-off is not spend-off: drafting still spends on your key unless
`LUCERNA_AUTO_COMMIT=0`.

---

## File contract (house-local)

Charter under `<house>/.amore/lucerna/` (daemon cannot write):

| File | Role |
|------|------|
| `enable.json` | durable dreams / auto-commit knobs |
| `budgets.json` | spend caps (file may raise above shipped; `aboveShipped` is visible) |
| `chores.json` | narrowing chore roster (`enabled`, `minIntervalHours` only) |
| `governance.user.toml` | additive `protected_extra` paths |

Runtime under `<house>/instruments/lucerna/`:

| File | Role |
|------|------|
| `health.json` | pid, startedAt, lastBeat, version, heartbeat interval |
| `state.json` | activity, last actions, budget counters |
| `log` | append-only plaintext activity log |
| `notifications.jsonl` | append-only notification queue (see below) |
| `halt` / `wake` / `sleep` | write-then-delete-on-consume sentinels |

Editing or deleting a charter file stops the **next** cycle from starting.
The `halt` sentinel and process stop are the only paths that interrupt work
already running.

### Notifications JSONL

Path: `instruments/lucerna/notifications.jsonl` in the house tree. One JSON
object per line:

```json
{"ts":"<ISO-8601 local>","level":"info|warn|error","kind":"<slug>","message":"<one line>","ref":"<optional relative path>"}
```

The writer is Lucerna; iris only reads. The file may be **absent**: the tab and
CLI render an honest empty list. Malformed lines are skipped. Rotation policy
(newest 200 when over 500) is owned by the writer.

### Pulse row

The Dashboard **Pulse** panel includes a Lucerna row: run state (not installed /
stopped / live / hung), last beat age when live, an optional `N rev` pending
review count when dreams or proposals await review, and the newest notification
message (or “no notifications”). When the daemon is Running and the capability
is `refusing`, the pulse token is `refusing` (amber), not a fifth liveness
state. The sub-line leads with the ceiling, then `0 chores today` when no
actions have run today.

---

## Security notes

- Iris binds loopback only (`127.0.0.1`) and is unauthenticated. Lucerna
  itself has no network listener.
- Process kill is pid-scoped and command-line verified; never by process name.
- Dreams stay off until the operator flips enablement. Drafting still spends
  unless `LUCERNA_AUTO_COMMIT=0`. Dry-run is a git word.
- Lucerna POSTs require `Content-Type: application/json`. That closes
  browser reachability (a visited page cannot submit a simple form). It is
  not authentication. Confirm dialogs are UX, not auth.
- Charter files under `.amore/lucerna/` are not daemon-writable.
- No new WAN surface is introduced by this control path.

Full autonomy defaults (install opt-in, governance, budgets, wall-timeout,
disable paths) and the egress inventory live in
[autonomy.md](autonomy.md) and [egress.md](egress.md). Capture a dream cycle
with [`scripts/lucerna_egress_capture.sh`](../scripts/lucerna_egress_capture.sh).
Policy entry point: [SECURITY.md](../SECURITY.md).
