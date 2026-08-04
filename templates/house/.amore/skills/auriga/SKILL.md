---
name: auriga
description: "Operational campaign orchestration under an explicit cost discipline — the budget-aware operational sibling of /forge-master. The main session becomes the charioteer: it enumerates a large action space (task sweeps, bug sweeps, elevation checklists, migrations), partitions it into exclusively-owned work units, dispatches build agents in waves via the built-in task tool (session-model judgment units; configured freight / disjoint-meter workhorse lane when the house has one), reviews handle REPORTS (handle-first, not output-first), redirects at wave boundaries via fix-rounds to the owning builder (never live observation of running agents), integrates behind mechanical gates, and closes the campaign manifest with a measured cost exhibit of turn/window/dispatch counts. Uses the SAME forge contracts as forge-master (dual-write handles/outputs, forge/sessions manifest, tracked in git per forge/README.md) with recipe: auriga + role: builder. TRIGGER when the operator wants operational work DRIVEN: 3+ implementation/fix/sweep units over a nameable action space, especially under budget pressure. SKIP: open-ended research/design/analysis (that is /forge-master — fidelity over economy; collapsing pipeline-shaped work to save tokens is auriga's cardinal vice); a single bounded build task (plain oeconomia dispatch, no campaign ceremony); git/org curation (keep-home always). Load /oeconomia alongside — auriga is its campaign-scale operationalization, never its replacement. NOT /forge-master (understanding — research/design pipelines) and NOT /oeconomia (the per-dispatch allocation contract): auriga drives an already-decided work-list to shipped."
---

# Auriga — operational campaigns under cost discipline

> *Auriga* — the charioteer: one hand, many horses; the reins are the handle contracts; the race is won on pace management. Judgment holds the reins; cheaper muscle pulls.

> Written for **Amore Build**: native task-tool dispatch, forge + AGENTS.md surfaces, cost accounting as window/turn/dispatch counts rather than dollar rate tables.

**SELF-UPDATING.** Same inline discipline as oeconomia §8: a measured claim that fails to reproduce, a verdict flip, or a hazard bite gets corrected here **in the same change that creates the fact**.

## §0 · Charter and the triad

Three skills, three jurisdictions, no overlap:

| Skill | Deliverable | Governing value |
|---|---|---|
| **/forge-master** | Understanding — research, design triangulation, synthesis, a decision | Fidelity over economy (its own charter, verbatim) |
| **/oeconomia** | Per-dispatch allocation — what stays in the orchestrator window, what routes out, at what tier | The Selected\|Original seam |
| **/auriga** | Shipped operational work — an enumerated action space driven to done | Capability per unit of orchestrator cost |

The border sentence, extended from oeconomia §0: *economy licenses errand delegation and campaign discipline; it never licenses avoidance of pipeline-shaped epistemic work.* If the question is "what should we build / how should we approach X," that is forge-master at full fidelity — decide there, then bring the decided work-list here. Auriga assumes the thinking about *what* is done; it drives the *doing*.

Auriga **obeys** every oeconomia hard rule (§5 there) and reuses forge-master's artifact contracts (dual-write, manifest, directory layout) so campaigns land in the same tracked `forge/` layout as pipelines (`forge/README.md` — handles/sessions campaign-scoped, pruned at completion). This file carries only the deltas.

## §1 · The campaign loop

0. **Scope.** Enumerate the action space — open tasks, deferral-audit hits, bug lists, elevation checklists. Recon is delegable freight (an explore sweep or a workhorse enumeration returns the list); the *cut* — what is in this campaign and what is not — is Original and stays home. Write the work-list into the manifest. *When the action space is itself found by review over one substrate (a bug/audit sweep), decorrelate the finding wave with per-agent [[skill://sortes]] draws when available — identical reviewers collapse onto the same list; distinct lens draws widen it and each `not surfaced:` line names a work-unit the others missed.*
1. **Partition by exclusive file-ownership.** Every unit names the files it owns AND the sibling-owned files it must not touch. Sweep for consumers of any seam the campaign will change and assign each explicitly — between-lists files are the proven leak (oeconomia §5). A needed-but-forbidden change ships in the unit's report as a ready-to-apply patch, never applied across the boundary.
2. **Author the protocol + briefs.** One versioned campaign protocol (gates, conventions, exemplar) referenced by every brief — never re-inlined. Per-unit brief: task, owned/forbidden files, sources, gates, handle+output paths (§4). Writing the briefs is design work you owed anyway.
3. **Name the wave's budget, then dispatch waves of 5–7, tier explicit on every dispatch** (tier table §3). Budget-first: before the wave fires, the manifest names its tier allocation (e.g. "wave 2: 4 freight-tier builds + 1 session-model judgment unit") — a wave without a named budget is an unpriced wave. Parallel independent dispatches in one orchestrator turn; keep ~5–7 per wave for backpressure + adaptive prompting. Fatter units beat thin ones — every dispatch carries a roughly flat briefing tax; amortize it.
4. **Review handle reports as they land.** Handle-first, spot-dip outputs only where a claim bears weight for an action (§5). Read early returns before the next wave fires; a misfiring brief is tuned once, not propagated.
5. **Redirect at wave boundaries — never by live observation.** Steering happens when reports land, not while agents run: watching an in-flight agent burns orchestrator window for nothing. When a landed report exhibits a defect, route the fix to the **owning builder** — prefer `resume_from` (or equivalent re-arm of the same child transcript) so context stays warm; otherwise a fresh task-tool dispatch with brief-shaped content: exhibited evidence, hypotheses to test, mechanical gates, verification targets. Re-dispatch only when the owner is gone or the defect crosses ownership boundaries; handle-first dual-writes bound what a dead agent cost you. Prompt-level lessons from early returns tune the NEXT wave's briefs (forge-master's adaptive-prompting window, inherited).
6. **Integrate behind mechanical gates.** Typecheck/test/lint expressed as "0 fail, baseline preserved" — never absolute counts (moving target under parallel test-adding builders). Commits use **explicit pathspecs** (`git commit -- <paths>`) — parallel sessions share the git index. Destructive/external actions stay home or run preview-gated.
7. **Account and close.** Finalize the manifest with the Outcome AND the Cost exhibit (§6). Distill anything durable to `knowledge/`/`tasks/`; flip any inbox item the campaign resolves in the same breath.

Poll output files, never assume completion (settlement is the notification, but the files are the record — builders above any output cap write part-files and report paths).

## §2 · The cost model

Honest campaign-scoped quantities are **turn counts, window estimates, and per-tier dispatch counts** — record those (§6). No dollar rate tables; no invoice fiction. The trend line carries the judgment.

**The orchestrator cost identity** — the single fact every campaign decision prices against (tier-agnostic; it holds for any cached-prefix provider):

> cost ∝ Σ over turns (window-size × cache-read weight) + (new content × cache-write weight) + (output × output weight)

The window is re-read **every turn** at the cache-read weight. A large read ingested mid-session bills many times at reduced rate — still several times the price of reading it fresh once, before counting the attention cost. Hence the three levers, in leverage order:

1. **Window size** — bulk never lands in the orchestrator window (handle-first, §5). Freight-reduction at source (index/semantic lookup) beats relocation.
2. **Turn count** — fewer, fatter turns: batch dispatches, batch independent tool calls, don't busy-poll.
3. **Tier** — a freight token burned on a workhorse (especially a **disjoint-meter** lane when the house has one) never touches the session window. Freight belongs on the cheapest adequate configured tier (§3).

**No fixed daily-dollar target.** The honest cost of a day scales with the *work* — a full-application build is not a lookup day — and with the pricing/subscription regime, both of which move; a fixed ceiling just mislabels a legitimately large day as a failure. The standing aim is a **direction, not a number**: a lean orchestrator window + freight on the cheapest adequate tier, judged by the **trend** (dispatch share bending toward workhorse tiers, §6) and by **cost-per-shipped-unit read against the work's scale**, never against an absolute ceiling.

**The tier map (native surface):** session model = default interactive + subagent tier — orchestration AND judgment-adjacent dispatched work live here; this is the judgment axis, not a premium to be avoided on reflex. Configured freight types (`[subagents.models]`, role/persona model defaults, spawn-time model override) = the workhorse for bounded, mechanically-gated units. When the house has a genuine **disjoint-meter subagent lane** (separate provider or subscription from the interactive session), prefer it for bulk gate-verified freight so session-window arithmetic stays clean. Each tier is itself finite in attention if not in cash: a campaign that relocates the whole bottleneck to a cheap type has not solved the problem, only moved it; watch it.

## §3 · Tier routing

Routing derives from residual intensity (oeconomia §2), and **a cheaper tier is earned by exhibit, never assumed** — adequacy is per-(task-shape × protocol). Prior exhibits on other harnesses lower the prior; they do not close the eval. Bank house verdicts in this table:

| Work | Tier | Status |
|---|---|---|
| Orchestration, architecture, which-change, synthesis, operator dialogue | Main session (session model) — dispatches nothing at its own tier for pure judgment | — |
| Judgment-adjacent builds (synthesis quality carries, gates can't verify); heavy comprehension | Task-tool `general-purpose` (inherits session model unless pinned) | House default where a gate can't carry verification for a cheaper tier |
| Bar-critical protocol-driven judging/review with mechanical exhibit gates | Session-model subagent, or a review-pinned type via config | Earn the pin by exhibit; do not assume a weaker tier is adequate |
| **Bounded, mechanically-gated build/edit/ops units** — scripted mechanical edits, recon/enumeration sweeps, build/test runs, gate-verified simpler builds | Configured freight type / **disjoint-meter workhorse lane** when present | Workhorse. Telemetry is often thin: the report file + re-running the mechanical gate at ingest carry verification weight |
| Fast read-only research, map-structure sweeps | `explore` (or equivalent read-only agent type) | No write surface by design |

Downgrade triggers stay live: a gate-rejection spike or calibration drift re-opens the eval and the row reverts.

## §4 · The builder contract (preamble — include in every build dispatch)

```
AURIGA CONVENTIONS (campaign mode — follow exactly):

You are a build agent in an auriga campaign. You will dual-write two files, HANDLE FIRST
(it is the checkpoint that survives if you die mid-flight).

**Handle** (compressed report, <500 words): {HANDLE_PATH}
**Full output** (complete build report, unlimited): {OUTPUT_PATH}

Frontmatter for both:
---
type: forge
role: builder
created: '{YYYY-MM-DD}'
pipeline: {CAMPAIGN_SLUG}
recipe: auriga
layer: {WAVE_NUMBER}
goal: "{ONE-LINE UNIT GOAL — quoted, no unquoted colons}"
triggered-by: operator
tags: [forge, auriga, {campaign tags}]
---

**Handle structure** (this is a REPORT, not an essay):
# {Unit Name} — Report
**Status:** complete | partial | blocked ({one line why})
**Gates:** {each gate: command → PASS/FAIL, verbatim tail on FAIL}
**Diffstat:** {files touched, +/- lines}
**Owned files:** {list} · **Forbidden files touched:** NONE (mandatory line)
## Decisions   {judgment calls made, one line each — the spot-dip targets}
## Foreign-file patches   {ready-to-apply diffs for files you do NOT own, or "none"}
## Deferrals   {anything left undone, with a named trigger — never silent}
## Open questions

**Ownership:** you own ONLY {OWNED_FILES}. Do not create, edit, or delete any other file
in the repo except your handle/output. A needed change to a forbidden file goes in
Foreign-file patches as a diff.
**Gates before reporting complete:** {GATE_COMMANDS} — run them; paste real results.
Express test gates as "0 fail, baseline preserved," never absolute counts.
**Source hygiene:** no org-system references (inbox/tasks/knowledge/forge paths) in code
or comments; rationale as plain documentation only.
**Read policy:** read only what the brief names plus what those files force. Context is finite.

YOUR TASK: {TASK}
SOURCES: {EXPLICIT PATHS}
PROTOCOL: {CAMPAIGN_PROTOCOL_PATH — read it first}
```

### Numeric/compute-unit rider (mandatory in every number-crunching brief)

Three clauses, REQUIRED in any brief whose unit does heavy numeric evaluation (any tier):

1. **Full local parallelism.** The implementation must size itself to the hardware — worker fan-out over the embarrassingly-parallel axis. A single-threaded hour-scale crunch is a brief-authoring failure, not a builder choice. Name the parallel axis explicitly in the brief.
2. **Progress artifacts.** The unit appends one line per milestone to a named progress file beside its results and writes partial results per completed stage where the format allows. Subagent telemetry is not always streamed to the orchestrator between settlement notices — the progress file IS the orchestrator's observability channel. Non-destructive liveness check = progress-file tail + a two-sample CPU-delta on the compute PID. Never kill a suspected-hung unit on suspicion alone — probe first.
3. **Language by workload, not by project substrate.** Whatever the project's default language is for instruments and glue, it is NOT the default for heavy numerics. When the unit's core is linear algebra, large matrix/eigen work, sieves, or long inner loops, the brief names an implementation whose throughput fits (BLAS-backed libraries, native/SIMD, GPU kernels where the workload maps). The gate contract is unchanged — only the engine under it changes.

## §5 · Reading discipline — handle-first, and why the inversion is honest

Forge-master's default is *read the full outputs* — correct for its jurisdiction: outputs there are **evidence** that synthesis and verification consume. A builder's output is a **report on gate-verified work** — the mechanical gate already did the verification a full read would approximate. So auriga inverts:

- **Trust** direct tool-call claims (a pasted passing gate, a diffstat).
- **Spot-dip** the *Decisions* section — judgment is evaluated as argument; open the output where a decision bears weight on integration.
- **Verify cheaply** anything documentation-shaped or load-bearing for an action (a quick `git diff --stat` / targeted read beats ingesting the report narrative).
- **Never** bulk-read outputs into the orchestrator window by default — that is the identity in §2 firing against you for the rest of the session.

Inside any forge-master pipeline the campaign spawns, forge-master's own reading rules govern — this inversion is auriga-scope only.

## §6 · Manifest and the cost exhibit

Manifest at `forge/sessions/{campaign-slug}.manifest.md`, authored **before** the first dispatch — same frontmatter and execution-log shape as forge-master's template with `recipe: auriga` (`forge/README.md` schema: pipeline, recipe, goal, role, layer, triggered-by), plus a `## Work Units` table (unit · wave · tier · owned files · status) in place of the agents-plan YAML, and one added closing section:

```markdown
## Cost
- Window: {date(s)} · orchestrator ~{N} turns · window at close ~{K} tokens · model {id}
- Budgets vs. actuals: wave budgets named at dispatch vs. what the wave burned
- Dispatches: {n} total — {a} × session-model · {b} × freight/workhorse · {c} × fix-rounds (resume/re-dispatch)
- Tier read: {did freight ride the cheapest adequate tier? which units re-tiered after exhibit}
- Cost read: {lean | heavy} for the work's scale · trend vs prior campaigns · one-line note if the orchestrator window dominated (the standing lever) — no fixed-ceiling pass/fail
```

Granularity is honest, not fake-precise: record the turn/window/dispatch counts (which ARE campaign-scoped) and estimate the share when concurrent sessions share a day. The point is a trend line across campaigns, not an invoice. Execution log stays append-only; frontmatter `status` flips only at completion.

## §7 · Hard-rules digest (violations are bugs, not style)

1. Tier explicit on every dispatch — agent type, config pin, or spawn-time model override named; freight units named as such in the campaign's Work Units table. Gate-verified mechanical units default to the workhorse tier (§3).
2. Ownership partition declared in every brief; seam-consumer sweep before wave 1.
3. Waves of 5–7 as parallel task-tool dispatches; read early returns; tune the next wave.
4. Fix-rounds route to the owning builder at report review — resume/re-arm preferred, brief-shaped content — never live-observe a running agent; fresh dispatch only if the owner is dead or the defect crosses boundaries.
5. Explicit-pathspec commits; verify the staged set (shared git index across parallel sessions). **File-granular beats directory-granular**: `git add <dir>/` sweeps a sibling session's uncommitted changes inside that directory into your commit. Name files when a sibling shares the tree. The hazard is bidirectional: a sibling session can sweep YOUR builders' uncommitted landed work under its own message mid-campaign — at integration run `git log --name-only` before assuming the working tree is yours to commit.
6. Poll output files; never assume batch completion; long outputs → part-files.
7. Handle-first ingest (§5); orientation reads and calibration reads stay home per oeconomia floors.
8. External/irreversible actions (fleet writes, publishes, rm/mv, git history) stay home or preview-gated regardless of how mechanical they look.
9. **Report paths are absolute + verified.** Briefs give absolute report paths under the house root (or the campaign's project root); the builder verifies both files exist after writing. An artifact-existence check catches a silent contract breach that the completion *claim* does not.
10. **Shared registration seams are integrator-owned**: when N units each register into one shared file, each owns only its own file and emits its registration as a foreign patch; the integrator applies all N single-writer at close. **Gate-forced breach refinement:** when a unit's mechanical gate requires the seam change to RUN, author the brief so gate and fence don't conflict: either the integrator pre-stubs the registrations before the wave, or the brief explicitly sanctions the in-tree seam touch as a disclosed foreign patch applied for gates (integrator still re-stacks at close).
11. **Nested delegation loses its return channel.** This harness keeps subagent nesting flat (depth one). Prefer flattening leaf work into campaign units when the list is knowable up front; do not rely on a unit spawning its own children.
12. **One campaign per session where the window allows.** The orchestrator's own window churn is the dominant cost; a fresh session per campaign starts the orchestrator lean. Chaining campaigns in one session is correct only when continuity value exceeds the re-read tax — an explicit judgment, not a default.

## §8 · Vices

- **The cheap collapse** — budget anxiety wearing auriga's clothes: flattening a genuine multi-angle design/research question into build dispatches. Forge-master's jurisdiction is not negotiable; the fidelity primitive there survives this skill's existence.
- **Ceremony** — a campaign manifest for a two-unit errand. Below ~3 units, plain oeconomia dispatch; below the floors, do it inline.
- **Delegate + trust** — unread reports, gates asserted but not pasted, "complete" ratified without the mandatory ownership line. The gate is mechanical or it is theater.
- **Unearned downgrade** — routing to a cheaper tier without the adequacy exhibit, then debugging its output at orchestrator rates (costs more than the tier saved).
- **Meter fixation** — optimizing the cost exhibit instead of the shipped work. The ledger serves the work; when they conflict, the non-hampering clause (oeconomia §0) wins and the delegation is re-shaped, not forced.

Companions: [[skill://oeconomia]] (the per-dispatch contract this operationalizes) · [[skill://forge-master]] (the epistemic sibling; artifact contracts inherited from it) · house `forge/README.md`.
