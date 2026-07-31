---
name: sentinel
description: Base discipline for session-hosted bounded watches (sentinels) — the arm/notify/review/re-arm loop, watch-mode hook suppression, predicate verification, escalation ladder, autonomous-latitude charter, and stand-down reporting. Load BEFORE starting any watch, alongside the domain skills the watch needs and, when one exists, the watch's archetype skill (archetypes layer on this file, never substitute for it). SKIP when no watch is being armed this session — this is not a general infrastructure-monitoring reference. NOT a persistent daemon — a watch that must run forever is the signal a daemon is needed; a sentinel is a deployment, not an institution.
---

# /sentinel — base discipline for session-hosted watches

A **sentinel** is a session-hosted autonomous watch: operator-initiated, bounded-duration, running detection cycles against live infrastructure with standing authority to mitigate and record.

**A sentinel is a deployment, not an institution.** It has a reason to exist NOW and a condition under which it stands down. Anything that should run *forever* belongs to a persistent daemon (long-lived process, scheduled service, or dedicated poller with bounded writes). This house runs no daemon of that kind by default — a sentinel that never stands down is the signal that one should graduate. Per-session latitude is broad precisely BECAUSE the deployment is bounded and operator-chartered.

## §0 · Skill maintenance (SELF-UPDATING) — read first

A stale watch-discipline skill is worse than none — the next watch inherits whatever this file says, whether or not it's still true. Update **in the same session that surfaces the fact**, never batched to stand-down or campaign end:

- **A gotcha that cost a live mistake** (a predicate that lies, a hook that doesn't suppress, a channel that silently drops) → land it in "The six disciplines" below.
- **A discipline actually violated during a watch** → sharpen its wording there (each of the six already cost a mistake once — that is why it exists).
- **A new watch shape used twice** → the trigger for a new archetype skill, never speculative creation ahead of a second real watch needing it. An unused archetype is rot.

**Admission filter.** A cross-watch gotcha or a loop/charter rule that would bite the *next* watch too → this skill. A domain-specific cadence, trigger catalog, or pre-authorized action list → the matching archetype skill (when one exists), never inlined here. A deep incident write-up or mechanism explanation → `knowledge/`, linked from here. Anything about one specific watch's run → that watch's task file, not this skill.

**Where dynamic state lives — NOT here.** What is currently armed, cycles run so far, incidents this watch, the live mitigation/reverse pair → the watch's own task file, created at ARM (see Succession below), and `context/current-state.md` if the watch is a standing project concern. This skill states standing reality only: the loop, the disciplines, the charter.

The base/archetype split mirrors primitives-over-opinions: this file is the alphabet, archetypes are the genres.

## The operating loop

```
ARM (once)          → baseline + verify predicates + verify alert channel + verify standing
                      access + set watch-mode
CYCLE (background)  → watcher script samples every <cadence>; exits 0 (clean) or 42 (fired)
NOTIFY              → the completed background job delivers / the monitor tool reports
REVIEW (sync)       → read the PRIOR cycle's output file SYNCHRONOUSLY (never chain the
                      review into the next background call — it hides results from you)
RE-ARM              → relaunch the watcher in background; one small turn per cycle
ENRICHED (hourly)   → deeper checks (topology/route/state reads) + the capture self-check
STAND-DOWN          → final report + remove watch-mode sentinel + commit
```

Watcher scripts live in the session temp area (`$TEMP/<name>-watch.sh`, or the Windows `%TEMP%` equivalent — session-scoped, disposable either way). Contract: internal loop of N samples × interval ≈ 9 minutes per cycle (sized to keep auto-delivery turnaround tight per cycle, not to any hard tool cap — a background job is not foreground-timeout-bound the way a blocking shell call is, but the *discipline* of short cycles + synchronous review is the point), `exit 0` clean / `exit 42` mitigation-fired / other = infra failure. On 42 the script performs its pre-authorized mitigation ITSELF (no model in the loop for the kill) and prints exactly what it executed + the reverse command. (Archetypes may deviate to detect-only watchers where recovery is diagnosis-bound rather than speed-bound — the deviation must be named in the archetype, not silent.)

**Harness mechanics.** Two delivery shapes, both acceptable — pick per watch and say which in the task file at ARM:

- **Per-cycle background job** (the monitor tool, or a short-lived background shell run): launch the watcher; its completion delivers to the session (that delivery IS the NOTIFY). REVIEW reads the prior cycle's output synchronously, then RE-ARM launches the next.
- **One long-lived watch process** (a monitor that streams events, or a scheduled task with a log the session tails): the watcher runs across cycles; the session is notified on each cycle boundary (or polls) and reads new output. NOTIFY = the monitor/schedule surface reporting completion or a new event line.

Either way the disciplines below are unchanged: read the prior cycle synchronously; never chain review into the next background call; one small turn per cycle.

**Standing access is an ARM predicate.** Any credential with a session/expiry the watch depends on (vault sessions, API tokens, short-lived deploy credentials) gets verified at ARM and the cadence checked against its lifetime; an auth failure mid-watch is an infra failure (non-42 exit), never a clean cycle — a watch that cannot see must say so, not report quiet.

## The six disciplines (each one cost a live mistake — do not relearn them)

1. **Verify every predicate both ways at arm time.** Run the detector against a known-true AND known-false case before trusting it. (A `grep 'time'` corrector check matched `timeout` — inverted truth for 40 cycles; a sniffer `set` failed silently and the capture ran unfiltered — twice.)
2. **The watch outranks the case.** When a side-investigation appears mid-watch, RE-ARM FIRST, investigate second. (A storm guard once sat un-armed for ten minutes during a related chase.)
3. **Review synchronously; background only the watcher.** See loop above.
4. **cwd is hostile.** Every probe carries its own `cd` or absolute paths — the working directory drifts across turns and failed probes return EMPTY, not errors. Pipe `2>&1` somewhere you will read; `2>/dev/null` on an unverified command hides module-not-found.
5. **Verify the alert channel at arm time, before the operator leaves.** The doctrine is harness- and house-independent: a channel you have not proven THIS WATCH is not a channel. Estate-specific channels (mail, pager, chat bots) stay with the estate that owns them — each house ESTABLISHES its own proven channel on first watch and records the proof in the watch task file (and later in this section if it becomes standing practice). Durable fallback everywhere: the git record (always written anyway).
6. **Cadence = risk profile.** ~9-min cycles for active-incident watches (storm/loop); 30–60-min for trend watches (logs, anomalies). Detection latency inside a cycle comes from the script's INTERNAL sample interval (e.g. 20s), not the cycle length.

## Watch-mode hook suppression

The doctrine: during an armed watch, suppress the noise-hooks that would otherwise nag the session about routine maintenance — the watch internalizes that discipline instead (see the self-check and stand-down requirements below, which are NOT optional). Some harnesses support a session-scoped `.watch-mode` sentinel file with self-expiry and touch-to-refresh.

**Adaptation — DEFERRED until first real watch lands it.** Under Arcus Build the maintenance-nag analog is the **native Stop gate** (a blocking `Stop` hook feeding the maintenance checklist back as a block reason). It does not yet honor a watch-mode sentinel. The first watch that arms adds a `.watch-mode` sentinel check at the stop gate (session-scoped file, self-expiry, refresh-on-touch) and lands the gotchas back in this section IN THE SAME SESSION. Until then:

- Name the unsuppressed-noise reality at ARM in the watch's task file (the maintenance gate may still fire mid-watch — treat its reminders as watch-mode internalized work, not interruptions).
- Arm the INTERNALIZED discipline regardless (it was always the real content):

- At every enriched interval, run the capture self-check: did the last hour produce a reusable insight (→ `knowledge/`), a bug (→ `inbox/investigations/`), a state change (→ the watch's task file)? Write it NOW, not at stand-down.
- Stand-down REQUIRES a watch report: cycles run, incidents, mitigations fired, anomalies parked, disciplines violated (honestly), committed to the watch's task file.

**REMOVE the sentinel at stand-down** when the suppression mechanism exists — a stale watch-mode file is a silenced hook forever.

## Autonomous-latitude charter (the standing orders)

Granted by the operator per-watch ("resolve issues, keep a clean record"). Within it:

- **Resolve** what the watch surfaces, including config writes via the domain tooling the watch needs — snapshot-first, dry-run-first where available, verify-read after every write whose flags you haven't used before (a silently-dropped matcher flag once built an over-broad firewall rule).
- **Record in the same breath**: every action lands in the watch's task file + git (commit as it happens; rebase/autostash discipline for the in-flight tree). The morning review must read as a narrative, not archaeology. Failed attempts are recorded too — including your own wrong calls (attribution honesty is standing house doctrine).
- **Park what isn't urgent**: a mystery with margin (e.g. a failed backup 17h old against a 48h threshold) becomes an `inbox/investigations/` file with the full evidence matrix + untested hypotheses + pickup instructions — not a 3am rabbit hole. State the margin explicitly when parking.
- **Pre-authorized mitigations only fire from the script** (deterministic, fast); the session VERIFIES after, then notifies. Everything beyond the pre-authorized list: escalate, don't improvise — the ladder is observe → mitigate (pre-authorized) → notify (verified channel) → wake the operator (only for: safety, data loss in progress, or mitigation that failed to hold).

## Succession

Assume the session can die mid-watch. The watch's task file must always carry: what is armed, the exact mitigation command + its REVERSE, the alert channel state, and the interpretation rule ("if a successor finds X disabled: that was the guard, not drift — re-enable with Y after investigating"). Write this at ARM, not when trouble starts.

## Archetype skills

**Status: none ship with this base package.** The trigger for creating the first is the §0 rule — a watch shape used twice, never speculative creation. What exists is the *base* (this file). Domain-specific archetypes (log/access-surface watches, app-health watches, L2/storm guards) live with the estates that need them and are **not** ported here; they are bound to particular surfaces (collectors, routers, deploy hosts). When a second real watch of one shape lands in this house, create `.arcus/skills/sentinel-<shape>/SKILL.md` layering on this base — archetypes name their deviations (e.g. detect-only watchers) explicitly and never substitute for this file.

---

Companions: the domain skills the watch needs (load alongside this base at ARM) · any house archetype skills under `.arcus/skills/sentinel-*/` once they exist · the watch's own task file (dynamic state) · the native Stop / maintenance gate (watch-mode suppression target, deferred until first watch lands it).
