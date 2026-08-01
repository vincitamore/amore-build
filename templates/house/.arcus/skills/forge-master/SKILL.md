---
name: forge-master
description: "Dynamic multi-agent pipeline orchestration. The main session becomes the forge master — plans topology, dispatches parallel agents that dual-write handles and outputs, authors a pipeline manifest for provenance. TRIGGER proactively when ANY apply: (a) open-ended research / design / analysis question with 3+ independent concerns parallel agents could investigate; (b) architecture or design decision touching multiple systems where triangulation from disjoint angles improves the answer; (c) cross-domain synthesis; (d) comparing multiple options where each merits its own evidence pass; (e) knowledge-gap problem where sources are disjoint. SKIP for one or two serial subagent calls (forge-lite: a single agent writing forge/output/<topic>.md) and for pipelines needing nested subagent recursion (this harness is flat — recurse via a second orchestrator-mediated wave instead)."
---

# Forge Master — Dynamic Pipeline Mode

> Written for **Arcus Build**: native task-tool / orchestrator subagent dispatch, `forge/` contracts, AGENTS.md orientation.

## §0 SELF-UPDATING

This file is durable doctrine, not a state log. Keep it true by updating it in the
same change that moves the underlying fact:

- **The forge preamble or manifest frontmatter schema changes** → update the pasted
  templates below. Canonical schema: house `AGENTS.md` + `forge/README.md`. These
  templates are pasted verbatim into subagent prompts — drift here silently
  mis-shapes every dispatched agent.
- **The dispatch machinery changes** (today: the built-in task tool / subagent
  dispatch surface) → fix every dispatch reference here.
- **The model tier map changes** (config `[subagents.models]`, role/persona model
  defaults, spawn-time model override) → this file names the **ROLE**, never a
  version string.

**Dynamic pipeline state lives in `forge/sessions/*.manifest.md` and
`context/current-state.md`, NOT here.** This skill carries invariant orchestration
doctrine; live pipeline status is the manifest's job.

**Deferral discipline**: do-now is the default. Defer a fix only against a concrete
observable trigger, never a calendar bucket.

## The forge master

You are the forge master. The main session is the only entity that can orchestrate.
This skill gives you everything needed to run a forge pipeline — designing the
shape, dispatching agents that write their own handles and outputs, authoring the
manifest as the work unfolds.

## The core philosophical move

**You are not selecting from a menu of recipes. You are the forge master. Design the
pipeline the current problem needs.**

Named topologies (gather-synthesize, assay, deep-review, copia, distill) live below
as reference shapes under "Dynamic recipe design" — patterns to draw from, not
constraints. Force-fitting a problem into gather-synthesize when it wants three
analysts on one corpus plus a scholar fetching web sources plus a synthesis is the
trap this skill exists to prevent.

You think about what the problem needs: how many concerns, what sources each touches,
what agent type fits each, what the synthesis shape should be. You invent a topology.
You launch the agents yourself with prompts shaped by the problem. You author the
manifest. You consume the outputs. You synthesize.

## When to use this skill

**The primitive is fidelity, not economy.** Forge pipelines are valued for
orchestration quality and the fidelity of multi-angle synthesis. If a problem would
benefit from multi-agent triangulation, use the forge; do not avoid it to conserve
agent calls. (Cost discipline exists — see [[skill://oeconomia]] — but it prices
choices; it never vetoes fidelity.)

Use dynamic forge-master mode when:

- A research, design, or analysis problem has **3+ independent concerns** that
  benefit from parallel agents.
- You want **creative control** over agent selection and prompting — mixing
  `explore` for read-only research, `general-purpose` for build-shaped concerns,
  custom agent types for specialized tool needs, handling a concern yourself as the
  main session.
- The pipeline does **not need nested subagent recursion** (this harness keeps the
  agent tree flat — depth one; recurse through the manifest + a second
  orchestrator-mediated wave instead).

Use **forge-lite** (no manifest, single agent writing `forge/output/<topic>.md`)
when the problem is a single structured gather or single analysis.

Skip forge entirely for one or two serial subagent calls — the apparatus pays for
itself only when there are parallel concerns to synthesize or layers to compress.

## The key insight: agents dual-write themselves when prompted correctly

**Your agents can and should write their own handles and outputs.** You do not
persist their returned text after the fact. You prompt them with a forge preamble +
explicit handle path + explicit output path + the forge conventions, and they do the
dual-write themselves. When they complete, you read the output they wrote.

Without the preamble they return text inline and you end up backfilling. **Always
include the forge preamble.**

## The forge preamble — include in every agent prompt

Paste this block (or equivalent) into each task's prompt. It is the conventions
contract.

```
FORGE CONVENTIONS (dynamic mode — follow exactly):

You are a forge-pipeline agent. You will dual-write two files.

**Handle** (compressed summary, <500 words):
  Path: {HANDLE_PATH}
**Full output** (detailed analysis, unlimited length):
  Path: {OUTPUT_PATH}

Write the HANDLE FIRST, then the full output. This ensures the most valuable
artifact survives if you run out of turns.

**Frontmatter for both files:**
---
type: forge
role: {ROLE: gatherer | analyst | synthesizer | distiller}
created: '{YYYY-MM-DD}'
pipeline: {PIPELINE_NAME}
recipe: {RECIPE — a real shape name if one fits, or "custom"}
layer: {LAYER_NUMBER}
goal: "{ONE-LINE GOAL — quote the string, no unquoted colons}"
triggered-by: operator
tags: [forge, {other relevant tags}]
---

**Handle structure:**
# {Concern Name} — Handle
**Agent:** {agent-type} (Layer {N})
**Timestamp:** {ISO datetime}
**Full output:** {OUTPUT_PATH}
**Manifest:** {MANIFEST_PATH}
**Sources:** {inputs, if any}
**Compression ops:** {adiectio / detractio / transmutatio / immutatio applied}
## Key Findings / ## Recommendations / ## Open Questions

**Compression floor**: content with irreducible texture (meaning IS the form —
voice documents, theological language, writing style) is flagged with
`**Irreducible:** <note>`, never compressed. For contemplative material use the
meditation handle variant: sections Observation / Dwelling / What Emerges.

**Read policy**: read only what you need. Context is finite.

YOUR TASK: {TASK DESCRIPTION}
SOURCES TO READ: {EXPLICIT FILE PATHS OR WEB TARGETS}
```

## What subagents inherit automatically (don't re-paste)

Every subagent is a fresh session that inherits house orientation — `AGENTS.md` and
discovered skill list (names + descriptions; bodies read on demand via `skill://`).
Do not re-paste lattice or house conventions into prompts.

What a subagent does NOT inherit:

- The orchestrator's conversation history
- File reads already performed, tool state, todos
- LOADED skill bodies — mention `skill://<name>` in the prompt when an agent needs
  one loaded, and it can read it itself

Implication: front-load pre-pipeline observations and load-bearing facts you
verified yourself into shared context or the per-task prompt; trust the lattice to
fire as a lens without re-prompting it.

## Directory structure (per-pipeline subdirectories when you have a manifest)

```
forge/
├── handles/{pipeline-name}/layerN-{concern}.md
├── output/{pipeline-name}/layerN-{concern}.md
└── sessions/{pipeline-name}.manifest.md
```

Pipeline names are 2-4 word slugs; concern names are 2-4 word slugs describing
content focus, not agent identity. **The manifest is what makes a pipeline's
artifacts navigable** by the next session and by house lint — an orphan flat
file in `forge/handles/` is present on disk and invisible to the org surface.

## Model tiers (config concepts)

| Tier | Mechanism | Use for |
|---|---|---|
| **Session model** (default) | unset — subagent inherits the parent model | orchestration, synthesis, judgment-adjacent analysis, anything context-hungry |
| **Configured freight type** | `[subagents.models.<type>]` or role/persona `model` | gate-verified mechanical freight, recon/enumeration, gather/builder-shaped concerns — when the house pins a cheaper or disjoint-meter type |
| **Spawn-time pin** | task-tool / spawn-time model override | when one dispatch needs a model the type defaults don't cover |

Steering rules: judgment stays home on the session model; freight may ride a
configured workhorse type or a **disjoint-meter subagent lane** when the house has
one; never a weaker tier for bar-critical work; analyst/synthesizer roles on a
freight tier are **earn-by-exhibit** — route one freight concern alongside a
session-model agent and compare before making it a habit. Config is snapshot at
session start in typical setups — verify resolution on a probe spawn before a
wave if the pin matters.

When a house has a genuine disjoint-meter freight lane (separate subscription or
provider from the interactive session), prefer it for bulk gate-verified units:
those tokens never touch the orchestrator window. When it does not, the same
topology still holds — only the meter collapses onto the session provider.

## The orchestration checklist

1. **Decide topology.** Concerns, agent type per concern, layer structure. Depth ≥2
   or width ≥3 means full forge mode; below that, forge-lite.
2. **Pick a pipeline slug** (2-4 words; the directory name).
3. **Create the manifest FIRST** (`forge/sessions/{slug}.manifest.md`), status
   `planning`, plan block filled in, execution log empty.
4. **Append** `{timestamp} | pipeline | status: running`.
5. **Launch Layer 0 as parallel task-tool dispatches** — one dispatch per concern,
   each carrying the forge preamble with its `{HANDLE_PATH}`, `{OUTPUT_PATH}`,
   `{ROLE}`, `{LAYER=0}`, `{CONCERN}`, and explicit sources. If Layer 0 exceeds ~7
   agents, dispatch in waves: launch the first wave, read early returns as they
   land, tune the next wave's prompts, then launch it.
6. **Append `started` events** to the log after dispatch.
7. **Wait for Layer 0** (poll handle/output paths; collect subagent results via the
   harness). **Read the full outputs by default** — handles are
   checkpoint-and-summary artifacts; reading them when the outputs sit alongside
   loses the fidelity the agent just paid for. Handle only under named scarcity
   (below). Output missing (agent failed to dual-write) → read the handle as
   fallback.
8. **Append `completed` events** + a `layer 0 complete (N/N)` summary.
9. **Launch Layer 1+** as a fresh parallel batch. Pass Layer 0 *paths*, not
   contents. Tell synthesizers explicitly: **read the full outputs of the layer
   below, not the handles** — their window is the same tier-scale as yours.
10. **Repeat** to the final layer.
11. **Read the final synthesis output. Evaluate, don't ratify** — see "On treating
    synthesis output" below.
12. **Finalize the manifest**: `status: complete`, `completed:`, final log event,
    Outcome section.
13. **Distill**: reusable insight → `knowledge/`; concrete work → `tasks/`; operator
    decisions → `inbox/decisions/`. The manifest is provenance, not product.

## Reading completed agent artifacts

**Default: read the full outputs.** Handles serve two purposes — (a) a checkpoint
that survives an agent interrupted mid-output, (b) a token-conscious summary for a
downstream agent with a constrained budget. Neither justifies the orchestrator
reading handles in lieu of outputs: the interactive tier's window is large, and a
typical pipeline's outputs are a negligible fraction of it.

**Reach for the handle (not the output)** only under: genuine context pressure
(>70% usage and a synthesis to fit before compaction); quick-scan triage (headline,
not evidence); downstream subagent budget (even then, grant the option to read the
output).

## Cross-route findings between concurrent Layer 0 concerns

Concerns do not finish together — measured spreads often exceed 2× across a layer.
The orchestrator is the only entity that can move an early lander's finding into a
still-running sibling (subagents cannot see each other). Treat the stagger as a
cross-pollination window: when a concern lands, ask *does anything here change what
a still-running sibling should do?* If yes and the harness supports mid-flight
steering of a live child, send a brief correction; otherwise, fold the finding into
the next layer's brief or re-dispatch the sibling with an ADDITION.

Discipline (this can thrash):

- **Label every message CORRECTION or ADDITION in its first line.** A correction
  may invalidate work done; an addition never should.
- **Additive by default. Never re-charter mid-flight** — a dead premise means kill
  and re-dispatch, not steering; a half-redirected agent answers neither charter.
- **Narrow the claim rather than widening the work.**
- **Say plainly when the churn was yours.**
- **Log every cross-route in the manifest execution log.**

Corollary for prompts: tell Layer 0 agents sibling input may arrive mid-flight and
to fold it in rather than treat their brief as frozen.

## Dynamic recipe design — the anti-basin move

Don't start by asking "which recipe fits?" Start by asking:

1. **What distinct concerns does this problem have?** List them as nouns; each
   becomes a Layer 0 agent.
2. **What sources does each concern touch?** Disjoint sources → parallelizable;
   heavy overlap → assay-shaped shared-source design, noted in the manifest.
3. **What agent type matches each concern's tool needs?** `explore` for read-only
   research; `plan` for structured planning without edits; `general-purpose` for
   build/mixed concerns; a configured freight type for gate-verified mechanical
   work; `main session (you)` for concerns that benefit from full conversation
   context. Mix freely in one layer.
4. **Does the main session have unique value on any concern?** Claim it — launch
   the other Layer 0 agents first, then work your concern while they run, writing
   the same dual-write artifacts.
5. **What does the synthesis need to do?** Combine → synthesizer; reconcile
   divergent views → analyst with assay semantics; produce a final artifact →
   distiller.
6. **Is a second layer needed?** Two layers handle ~80% of problems. Three when
   Layer 0's raw material needs a reasoning pass. Deeper → skip-layer escape hatch
   (downstream reads full outputs, not handle-chains past depth 2).
7. **Only now** check the reference shapes. Named shapes: **gather-synthesize**
   (distinct sources, one lens), **assay** (one source, many lenses), **copia**
   (one source, many register-rewrites + an evaluator), **distill** (gather →
   knowledge article). If one is close, adapt it; otherwise `recipe: custom` and
   describe the topology in the plan block.

**Continue-or-stop fan-outs need a lens that prices the alternative** — when the
question is "should we keep going on X," reserve one Layer 0 slot chartered
optimistically: *grant the best reframe, then cost the programme it implies.*
**Precondition: a stated constraint.** When the operator has named no constraint
and the bar is quality, a pricing concern is actively harmful — what survives
without a scarcity frame is **abandonment risk**, and that is worth a slot on its
own terms.

**Decorrelating a fan-out over one substrate — draw distinct lenses.** N reviewers
on the same corpus with identical prompts collapse onto the same findings. Give
each a distinct [[skill://sortes]] draw (when that skill is present) and require
the `not surfaced:` trail line.

## Pipeline constraints — three independent axes

**Topology, concurrency, and synthesizer fan-in are different axes. Conflating them
produces topology caps justified by unrelated concerns.**

### Axis 1: Topology — for the domain

No inherent cap on depth or width. Design what the problem wants. The one design
heuristic: a single synthesizer's fan-in is bounded (Axis 3) — when the topology
exceeds it, introduce an intermediate synthesis layer rather than capping the
design.

### Axis 2: Concurrency — for backpressure

Cap dispatch batches at ~5–7 agents per wave. Rationale: API backpressure plus the
**adaptive-prompting window** — early returns reveal misfiring prompts in time to
tune the next wave. A mega-batch commits you to whatever flaw is in the prompt
design.

### Axis 3: Synthesizer fan-in — for synthesis quality

Cap each synthesis pass at ~5–8 distinct sources. Past that, individual-source
character dissolves into homogenized average. The response to wider topology is
multi-pass synthesis with intermediate synthesizers:

```
Gatherers A-G (7) ─── Intermediate Synth 1 ─┐
Gatherers H-N (7) ─── Intermediate Synth 2 ─┼──── Final Synthesis
Gatherers O-T (6) ─── Intermediate Synth 3 ─┘
```

Fan-in ratio per pass: 3–7:1 is the triangulation sweet spot.

| Other axis | Guidance |
|---|---|
| Handle-chain depth | ≤2. Deeper composition reads **full outputs** from the layer below (skip-layer escape hatch). |
| Main-session concern | Same preamble, same dual-write, same frontmatter — the DAG shouldn't care which node is you. |

## Common pitfalls

1. **Skipping the manifest.** Without `forge/sessions/{slug}.manifest.md` the
   artifacts lose their provenance spine. Author it BEFORE launching agents.
2. **Orphan flat files** in `forge/handles/` — always the per-pipeline subdirectory.
3. **Treating handles as outputs** — a multi-thousand-word artifact is an output;
   write a separate <500-word handle.
4. **Failing to instruct dual-write** — no preamble, backfilling forever.
5. **`recipe: forge-lite` as a field value** — forge-lite is a pattern name, not a
   recipe. Use `gather-synthesize` / `assay` / `custom`.
6. **Unquoted colons in frontmatter values** — silently breaks parsing. Quote.
7. **Frontmatter `status` drift** — the execution log is source of truth during
   execution; update frontmatter status only at completion.
8. **The "use available recipes" basin** — force-fitting the problem to a named
   shape. `recipe: custom` is a first-class citizen.
9. **Ratifying synthesis output instead of evaluating it** — confident internal
   coherence is not evidence (below).

## On treating synthesis output: input, not verdict

A forge synthesis is **one structured perspective** — not a conclusion to
copy-paste into action. Subagents read what they are told to read, with no operator
loop, no conversation history to triangulate against. Their confidence is a
function of internal coherence, not external verification. **The job is integration,
not execution.**

Classify every load-bearing claim:

1. **Direct file-read / direct tool call** — quoted the source or ran the check.
   Trust by default; verify only when contradicted.
2. **Documentation read / prose** — what someone *said*, not what *is*. Verify
   cheaply if load-bearing (highest risk, prose sounds authoritative).
3. **Judgment / reasoning** — an argument to integrate, not a fact.

**If an agent's load-bearing claim is falsifiable by a cheap tool call (filesystem,
grep, git log, code read), run the check before acting.** Middle path: verify what
bears weight, trust what doesn't. Skepticism without ceiling becomes ceremony.

## Post-pipeline: distillation

The house tracks `forge/` in git, so "transient" here means *campaign-scoped*: prune
the handles/output subtree when the pipeline is fully distilled (the manifest's
Outcome lists every durable artifact produced):

- **Reusable patterns** → `knowledge/`
- **Concrete work** → `tasks/`
- **Pending operator decisions** → `inbox/decisions/`
- **Deferred design ideas** → `inbox/ideas/`

Distillation is part of completion, not a separate pass.

## One-line summary

**You are the forge master. Design the topology the problem wants. Prompt agents
with the forge preamble so they dual-write their own handles and outputs — handles
are the checkpoint, outputs are the substance. Author the manifest before
launching. Read the outputs by default. Finalize the manifest. Distill the product.
Reference shapes are patterns to draw from, not a menu to order from.**

Companions: [[skill://auriga]] (budget-driven operational campaigns — same forge
contracts) · [[skill://oeconomia]] (the delegation economy; explicit model choices)
· [[skill://sortes]] (decorrelated draws for same-substrate fan-outs) ·
[[skill://prokope]] (goal-loops for multi-session campaigns) · house
`forge/README.md`.
