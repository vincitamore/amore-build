---
name: oeconomia
description: >-
  Delegation economy for budget-precious orchestrator sessions: keep the
  orchestrator's compounding window lean by routing high-freight/low-judgment
  work to subagents on KNOWN model resolutions. REFLEX (holds even before the
  body loads): (1) EVERY dispatch fires with its model resolution KNOWN —
  without an explicit pin a subagent inherits the parent/session model via
  resolution order (spawn-time/runtime override → [subagents.models.<name>] →
  the agent definition's own model → parent session model). A blind spawn silently
  inherits the orchestrator. Prefer type pins in config and spawn-time overrides
  when the dispatch must not share the session meter; (2) delegate bulk + early
  — multi-file comprehension reads, protocol-driven review/judging sweeps,
  build/test runs, scripted bulk edits — bulk freight must never land in the
  orchestrator's window, where every token is re-sent at the cache-read weight
  on every remaining turn; (3) keep judgment — architecture, which-change
  decisions, synthesis, calibration reads, git/org curation, operator dialogue;
  (4) floor — a single known-file read, a one-off grep/glob lookup, a two-line
  edit, or any read near session-end stays home; (5) PREFERRED TIER-USE:
  configured freight types for bounded, mechanically-gated work; session-model
  (or a stronger pin) for judgment-adjacent bounded work the gates can't
  verify; never an unearned cheaper tier. Load the body BEFORE: dispatching or
  inlining a heavy multi-file read; a bounded code task mid-conversation;
  forming a review/judge wave; continuing any session whose context is heading
  into fatigue territory. SKIP in cheap short sessions (most research/lookup
  work) — imposing delegation ceremony there is this skill's vice. Economy
  licenses errand delegation, never avoidance of pipeline-shaped work — 3+
  independent concerns needing synthesis is /forge-master's jurisdiction.
  NOT /forge-master (pipeline-shaped epistemic work) and NOT /auriga
  (campaign-scale build orchestration) — this is the per-dispatch allocation
  contract both of those obey.
---

# Oeconomia — the delegation economy contract

> **SELF-UPDATING.** A stale contract mis-allocates every future session's budget — worse than no contract. Update this file **in the same change that creates the fact**, per §8's triggers; the act of noticing is the trigger. Operational doctrine only — history lives in git and the task record, never accreted here.

> Written for **Amore Build**: native task-tool dispatch, model resolution via `[subagents.models]`, role/persona defaults, and spawn-time model override.

The operational contract. Deeper doctrine and formation notes may live beside this skill as a companion file if the house authors one; this file is what you follow.

## 0. Charter and jurisdiction

- **Governs**: everyday intra-session work allocation when a budget-precious orchestrator can dispatch plentiful workhorse subagents. Errands, background reads, bounded code tasks, review sweeps.
- **Does not govern**: pipeline-shaped work — 3+ independent concerns wanting parallel investigation and synthesis. That is [[skill://forge-master]]. **The border sentence: economy licenses errand delegation; it never licenses avoidance of pipeline-shaped work.** Collapsing a genuine multi-angle pipeline into one under-powered errand to save tokens is this contract's worst failure mode — budget anxiety wearing the doctrine's clothes.
- **Regime check**: when the session model IS the workhorse (no cheaper configured type, no disjoint-meter lane), the cash thesis loses force; the classification lens still improves the work. What stays real regardless: (a) the window arithmetic — every in-window token is re-sent at the cache-read weight every remaining turn; (b) the attention argument — a lean window is a sharper mind, at any price; (c) a configured alternate-provider pin (when present) is a genuinely separate meter. In a single-model session this contract is a **window-hygiene and discipline** contract more than a cash contract — accept that consciously, don't cargo-cult the urgency.
- **Non-hampering clause**: the contract may never degrade the work. Delegation forces crisp specification, which raises quality; where it would lower fidelity instead, fidelity wins and the delegation is re-shaped, not forced.

## 1. The economy in three lines

- The orchestrator's budget is dominated by **re-reading its own accumulated window**. Thinking — the undelegatable work — is most of what it generates.
- Therefore the true cost of a context-entering read is **`freight × expected-remaining-turns`**; a subagent's window is disposable. **Delegate bulk, early.** A lean window is also a sharper mind — the attention argument outlives any pricing regime.
- Delegation **halves, never eliminates** orchestrator cost. Design, calibration, briefs, and ingest are irreducibly yours.

## 2. The lens

Classify every action by the **judgment-density of its output given the extendable substrate** — never by token count. Ladder: **Stock** (retrievable) → **Implied** (derivable, no choice) → **Selected** (choice from supplied criteria) → **Original** (criteria/position/architecture must be originated).

- **The boundary is the Selected|Original seam, and it is a theorem, not a taste**: at Selected and below, verification costs less than production (a machine or a spot-read checks it); at Original, verification *is* re-production — delegating it costs twice, not half. The economy closes only where verification < production.
- **Delegation = substrate-extension.** Intensity is relative to the substrate, and you author the substrate. Deposit the Original criteria once — versioned protocol file, schema, worked exemplar — and each dispatch's residual drops to Selected. The brief is the per-dispatch marginal cost and doubles as a thinking tool: writing it is design work you owed anyway.
- **Residual-Original diagnostic**: Original judgment leaking from a delegated output forks — leak *generalizes* (names a missing rule) → enrich the protocol, re-dispatch (the leak specifies the fix); leak is *terminal* (it IS the deliverable) → misclassified, pull it home. Fan-out is also an epistemic instrument: independent agents converging on the same abstention is protocol-falsification evidence one mind cannot generate.
- **Consequence rider, orthogonal to intensity**: a Stock-intensity delete is not a Stock-intensity read. Mutating writes want diff/lint gates; external or irreversible actions (fleet writes, publishes, rm/mv, git history) stay home or run preview/dry-run first, however mechanical they look.
- Two classes sit outside the ladder: **operator dialogue** (Original by address — the substrate cannot contain it) and **dispatch itself** (constitutive — the boundary-drawing is not delegable to the bounded).

## 3. The action-class verdicts

| Action class | Verdict | Extension needed | Gate |
|---|---|---|---|
| Comprehension reads (multi-file evidence/code) — the dominant freight class | **delegate-always** when bulk | file-paths in brief; filter-protocol if recurring | spot-read the handle |
| Inspection/search sweeps | **delegate-when** bundled into a task | narrow mandate | self-evident result |
| Single targeted lookup (known file, one grep) | **keep** — below floor | — | — |
| Orientation reads (session-defining context) | **keep-always** | — | — |
| Build/test **runs** | **delegate** the run | none (the failure names itself) | exit code / first error |
| Novel-failure **diagnosis** | **keep** (Original) | — | — |
| Code authoring | **split**: delegate comprehension reads + boilerplate-from-exemplar; **keep which-change + architecture** | worked exemplar; scoped brief | tests/typecheck/build + diff read |
| Mechanical edit sweeps (uniform, many files) | **delegate** | pattern + file-set brief | diff review + compile/test |
| Doc/synthesis authoring | **split**: delegate first-draft bulk arrangement; **keep synthesis + new inference** | outline/protocol + prior handles | spot-read + citation grep |
| Review/judging | **delegate-when** a protocol externalizes the criteria; keep single-item or tacit-criteria judgment | **versioned protocol file** | mechanical exhibit gate + altitude spot-read |
| Ops/fleet | **split**: delegate bulk reads; **keep or preview-gate writes** | skill pointer (the tool's own skill) | reads mechanical; writes dry-run |
| Git, org bookkeeping | **keep-always** (curation judgment, governance acts) | — | diff/lint self-check |
| Scripted shell bulk | **delegate** early | brief/script | mechanical; preview destructive |
| Dispatch/orchestration, operator dialogue, thinking | **keep-always** (constitutive · addressed · irreducible) | — | — |

## 4. Handoff shapes (all four, every delegation)

1. **Versioned protocol file** for recurring criteria — never re-inline per dispatch. It is also where residual-Original leaks get folded back in, so it improves under use.
2. **File-based briefs in / file outputs back** — payloads stay off the wire and out of the window. The dispatch is a pointer (~a hundred tokens); the reply is one line; the substance is on disk. Dual-write handle-first (`forge/handles/` then `forge/output/`, per `forge/README.md`) so a checkpoint survives the agent's death.
3. **Mechanical gate at ingest** — the highest-leverage move: **constrain the output shape until the gate is mechanical** (schema validation, quote-must-be-found exhibit anchors, tests). "Delegate + verify mechanically" is the pattern; "delegate + trust" is the failure mode.
4. **Model resolution is checked, not assumed** — know the resolution order before the wave: **spawn-time/runtime override → `[subagents.models.<name>]` in config → the agent definition's own `model:` → parent session model**. Note the middle pair: a **config pin outranks the agent definition**, so a `model:` written into a definition loses to a `[subagents.models]` entry you may have forgotten — the surprising direction, and the one worth checking. A dispatch whose resolution you haven't reasoned about inherits the orchestrator's model and meter silently. Before any wave that depends on a pin, verify one spawn's actual resolution (status badge, transcript header, or harness equivalent).

## 5. Dispatch mechanics — hard rules and measured hazards

- **KNOW the model resolution on every dispatch, no exceptions.** Native surface: the task tool / subagent dispatch. Config pins live under `[subagents.models]` and role/persona `model` fields in project or user config; spawn-time model override pins a single call. Config edits typically apply to *new* sessions — if you need a mid-session exception, use the spawn-time override. Before any wave, verify ONE spawn's actual resolution.
- **Model ROUTING derives from residual intensity, and a cheaper tier is earned by exhibit, never assumed.** Protocol-driven work whose ingest gate is mechanical → the cheapest tier that has PASSED an adequacy eval *for that task-shape*: blind N-unit sample judged by the candidate vs a stronger incumbent's baseline — measure recall-of-keeps, gate-failure rate, type/direction agreement — promote on the numbers. Judgment-adjacent bounded work → the strong / session tier. Original → never dispatched at any tier (the §2 seam). Adequacy is **per-(task-shape × protocol × tier), never global** — and **not portable across models**. Downgrade triggers: a gate-rejection spike or a calibration drift on an ungated dimension re-opens the eval.
- **House instantiation (fill in for your setup):** document which agent types / config pins are freight vs judgment. When a **disjoint-meter subagent lane** exists (separate provider or subscription), prefer it for bulk gate-verified freight so session-window arithmetic stays clean. **Budgets are named before spend, exhibits after**: before a wave, say what it should cost in units (dispatches × tier) and what exhibit settles whether it did.
- **Recovery after a dead agent is checkpoint-first.** Prefer resume/`resume_from` of a completed owner when the harness supports it; otherwise re-dispatch with the same brief. Handle-first dual-writes are the checkpoint that makes re-dispatch cheap. Do not build a wave plan on unprobed mid-flight recovery semantics.
- **Output caps → part-files**: large-output agents write part-files and report paths, or the ending may silently never land.
- **Unit-sizing**: each dispatch carries a roughly flat briefing/context tax — prefer fewer, fatter units where items are independent anyway. Amortize protocols over the full multi-round cascade, not one wave. Waves of ~5–7 per batch remain good discipline.
- **A batch is not atomic with its dispatch** — poll the handle/output files, never assume completion. The *file artifacts* are the contract.
- **Ingest — the economy rider**: default to **handle + surgical spot-dip**; open a full output only where a claim bears weight for an action (verify documentation-shaped claims cheaply; trust direct tool-call claims; evaluate judgment as argument). This deliberately tightens forge-master's "read full outputs by default" for budget-constrained orchestrators. Inside pipelines this rider governs only what the orchestrator reads back, never topology or fidelity.
- **Parallel dispatch into ONE codebase: partition by exclusive file-ownership, declared in every brief.** Each brief names the files that agent owns AND names the sibling-owned files as do-not-touch; a needed-but-forbidden change goes in the agent's summary as a **ready-to-apply patch**, never applied across the boundary — the integrator applies it after the owner finishes. Corollaries: **literal test-COUNT gates are moving targets under parallel test-adding agents** — express shared gates as "0 fail, baseline preserved," never an absolute count; transient diagnostic noise from siblings mid-edit is expected — judge only finished gates; **a seam change flushes out between-lists files** — before dispatching, sweep for consumers of any seam you changed and assign each explicitly; **parallel SESSIONS in one repo share the git INDEX** — commit with explicit file-granular pathspecs (`git commit -- <files>`), re-read AND `git diff` before committing, describe only your own hunks.
- **Fix-rounds route back to the module's builder**, never a fresh cold dispatch when the owner still holds context: use resume/re-arm of the same child when available; otherwise a focused re-dispatch. Give the fix message the same shape as a brief: exhibited evidence, named hypotheses to test (not conclusions), mechanical gates, verification targets. Re-dispatch cold only when the owner is gone or the defect crosses ownership boundaries.

## 6. Floors — when NOT to delegate

One line, three derivations that coincide: **delegate bulk + early; keep single-cheap-call, near-session-end, and Original.**

Enumerated keeps: one known-file read · one grep/glob lookup · a two-line edit · any read whose purpose is your own calibration or position-forming · reads in a session about to end · **and when the operator is present and waiting, a thirty-second inline read beats a three-minute dispatch** — human latency is a floor the token arithmetic misses.

**The freight-already-paid refinement**: a ready-made patch whose text you already ingested (you read it to review or receive it) is nearly free to apply inline — the window cost was paid at read time; a dispatch would ADD a flat dispatch tax to save nothing. Delegating patch-application pays only when the edit content can stay out of your window end-to-end (possible only where the gate is mechanical enough that you never read the patch at all).

**Freight reduction at source beats relocation**: prefer a targeted semantic/index lookup over a bulk read when a lookup suffices.

## 7. Session-shape guidance

The contract earns its keep in **heavy sessions** — coding/orchestration/debug work whose context heads toward fatigue. Window-fatigue is often the binding constraint long before hard overflow, and the attention argument is the one that fires. In cheap short sessions the floors keep it inert; if it is adding dispatch ceremony to a short session, that is the vice firing — stop.

## 8. SELF-UPDATING — inline self-maintenance, never batched

**When this skill MUST be updated (in the same change that creates the fact, not later):**

- **A measured claim fails to reproduce** → correct it here, date-stamped. The act of noticing is the trigger.
- **The harness surface moves** (task-tool params, model-resolution precedence, output caps, a new agent type or pin) → re-verify §4/§5 mechanics against the live surface before building on them; each mechanics claim carries its verification date.
- **A verdict flips or a new action class emerges in live use** → §3 table updated before the session ends, with the exhibit noted.
- **A new handoff shape or gate proves itself in use** (twice — once is an anecdote) → §4/§6 gets it.
- **A floor mis-call or a hazard bite** → §5/§6 sharpened at stand-down, not next quarter.
- **Account economics get measured** (provider spend, window trends) → §5's "budgets named before spend" paragraph gets real numbers.
- **You find a section stale** → fix it immediately.

**Compounding checklist (every heavy orchestration session leaves this sharper):** at stand-down ask — hazard hit that §5 didn't warn about? floor that mis-fired? verdict that felt wrong? gotcha worth more than the session (→ `knowledge/` + a line here)?

**Deferral discipline:** do-now is the default. Defer a fix only with a concrete observable trigger, never a calendar bucket.

**Loading ladder:** A — this skill, reflex in the description — is live. **B** (promote a 3–5 line always-on reflex core) requires a *lived* exhibit of the description under-firing, never anticipation. **C** (decision-moment hook on heavy reads) requires A+B exhibited insufficient. Conservative entry, cheap exit.

Companion: [[skill://forge-master]] (pipelines; the border) · [[skill://auriga]] (campaign-scale builds) · [[skill://isda]] (the lens's parent theory, when present).
