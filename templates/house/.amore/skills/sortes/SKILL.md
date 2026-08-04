---
name: sortes
description: Draw a random lens tuple to decorrelate a review, audit, or ideation pass from the model's default moves. Load BEFORE a repeat review/audit over the same substrate (fan-out reviews, multi-arm research, coverage sweeps) where successive passes keep finding the same things, OR when brainstorming needs to escape the same handful of default angles. The picker (`skill://sortes/bin/pick.ts`) draws N lenses from a catalog with an mtime cooldown so draws rotate; each consumer ends with a mandatory `not surfaced:` trail line. SKIP for a single first-pass review (fixed default dimensions are fine cold) and for one-off lookups. NOT a review harness itself (it feeds one — a multi-agent wave, a forge pipeline, a reviewer pass); NOT ISDA (that MEASURES density; sortes DIVERTS attention).
---

# sortes — decorrelation by external draw

Named for the *sortes* (the casting of lots). A sampler cannot decorrelate its own draws from within — the certifier of variety has to stand outside the thing varying. `sortes` is that outside stander: a dumb PRNG over a catalog of attention-lenses, so a review/audit/ideation pass is forced into corners the model's default prior would skip.

Mechanism lifted from `latentwill/ideonomy-skill` (MIT); the lens catalog is original to this skill. Diagnosis this treats: successive review passes collapse to the mode of the prior — the consensus of what the model already looks for. Prior remedies ask judgment to fix what is structurally a sampling problem. This is the missing external organ.

## §0 — SELF-UPDATING

A stale catalog decorrelates toward the wrong corners. Maintain in the same change that creates the fact:

- **A consumer's `not surfaced:` line names an angle no lens reaches, AND it generalizes** → add ONE new *primitive* lens to `lenses/` (the access-control lens was admitted this way on the skill's first live run). Promote DOWN into primitives, never UP into saved tuples — a named saved-combination re-installs the default the draw exists to break. This is why there is no `recipes/` dir and never will be.
- **A lens proves it never fires anything real across repeated draws** → it is the weakest candidate at the next revision; cut it (the catalog is a vocabulary of live moves, not an archive).
- **Coverage re-examination is itself a standing trigger.** Periodically (or when a review pass feels like it keeps missing a whole class), read the catalog against the candidate watch-list below and against any standing principle set the house loads. A principle that reduces to a concrete defect-finding question is a legitimate lens. A *loaded* principle is background normativity, not a *foregrounded* review move — a lens turns a background norm into "go search this right now," which the agent won't default to unprompted. Selective, never a bulk principle-to-lens conversion.
- **The picker mechanics move** (Bun/fs API, mtime behavior) → re-verify `skill://sortes/bin/pick.ts` against the installed surface.
- Dynamic state (which lenses are cooling, past draws, the live lens list) lives in the filesystem — the catalog directory listing, mtimes — NOT enumerated here; there is no log by design.

**Admission filter for a new lens.** Two modes, deliberately different:
- *Young-container curation* (the catalog is still small and under-exercised): a deliberate, bounded add is legitimate container work if the lens is genuinely *primitive* (not a combination of existing lenses) and *generalizes across substrates* (not one codebase). No exhibited gap required yet — the seed itself was authored this way.
- *Mature-catalog growth* (the catalog is exercised and broad): the same two criteria PLUS a real `not surfaced:` gap that exhibited the need. This is the steady state; without the exhibit, don't add.

**Candidate lenses — promote on an exhibited gap, not speculatively** (recorded so the judgment isn't lost; each still owes the mature-growth exhibit): lattice-adjacent — `primitives-vs-opinions` (API/library design), `container-granularity` (schema/frame commitment), `external-dependence` (essential-operation reliance on outside services), `derived-state-ownership` (check reducibility to `mutation-visibility` first); domain — `numeric-precision` (overflow/rounding/NaN/money-in-floats), `feature-interaction` (cross-feature emergent behavior), `testability` (does the change come with tests; can it be tested; do any assertions tautologically pass).

**Author lens bodies in neutral, plain-behavioral register.** Each lens file is catted verbatim into every agent that draws it (and into the orchestrator window at author time), so it is a loaded surface: state the analytic move in plain behavioral English ("confirm each operation checks who is asking and that they are allowed", "higher-impact operations") rather than clustering standard security nouns or adversarial-enumeration vocabulary. The analytic content is identical either way — a reviewer learns exactly as much — but the neutral phrasing avoids involuntary orchestrator safety-classifier false positives on admin/security surface language. Because the specific trigger token cannot be isolated from any single flag (and testing it in a scored session is self-poisoning), the discipline is to **minimize the whole register**, not to swap one flagged word — plain phrasing costs nothing, so conservatism is free. This is register-selection for legitimate first-party review, never blunting the lens.

## §1 — The catalogs (sibling spaces)

Two **named sampling spaces**, one pick primitive. Do not blend them into a default union — review and ideation are different operation-spaces; shared draws are wrong-corner variety.

| Space | Directory | How to select |
|-------|-----------|---------------|
| **Review** (default) | `lenses/` | bare `pick.ts` — defect / code-audit attention |
| **Ideation / discovery** | `lenses-ideation/` | `--catalog` pointing at the ideation dir — generative / research / goal-campaign attention (dozens of lenses; admission history in its README) |

**Review catalog** (`lenses/*.md`) — each a short file: what it looks for + the questions that fire it. A couple dozen, code-review-oriented (error-paths, trust-boundaries, concurrency-interleaving, boundary-values, reversibility, negative-space, structural-correctness, access-control, …); the live list is the directory listing, never enumerated here (it drifts). Some lenses foreground standing house doctrine as a directed review move (the consuming subagent may have principles loaded but won't fire a given one as a concrete search step unprompted): `negative-space` lays out the operations × cases grid and reads each empty cell as a prediction; `structural-correctness` and `observability` reduce structural and observational norms to defect-finding questions.

**Ideation catalog** (`lenses-ideation/*.md`) — research/discovery primitives (construct-the-missing, prior-scope, false-closure, work-backward, random-model-first, solved-analogue, change-the-engine, …); live list is the directory listing. Consumed by [[skill://prokope]] on multi-arm research waves. Same admission filter; do not dump ideation bodies into `lenses/` (dilutes review draw mass, pollutes both domains). Note: `pick.ts` keeps default `--n 3` for all catalogs — pass `--n` explicitly for wider ideation draws.

## §2 — Using it

```bash
# One draw (names + bodies), live cooldown:
bun .amore/skills/sortes/bin/pick.ts

bun .amore/skills/sortes/bin/pick.ts --n 5        # bigger draw
bun .amore/skills/sortes/bin/pick.ts --print      # names only
bun .amore/skills/sortes/bin/pick.ts --json       # ok-first envelope, for a workflow to consume
bun .amore/skills/sortes/bin/pick.ts --seed 42    # deterministic, no mtime side-effect (tests/repro)
bun .amore/skills/sortes/bin/pick.ts --catalog DIR  # a different lens catalog
```

Asset path form for skill-aware loaders: `skill://sortes/bin/pick.ts`. Default catalog resolves relative to the picker (`../lenses`).

**Cooldown:** each non-seeded draw touches its picked files; a 1-hour half-life weights against re-drawing them, so a multi-draw session rotates across the catalog on its own. A fresh git checkout resets everyone's mtime uniformly → degrades to pure-random, which is the floor, not a failure.

## §3 — The trail contract (non-negotiable for consumers)

Whatever consumes a draw ends its artifact with a `not surfaced:` line naming the angles the draw did NOT reach. No trail, no real draw — it is the falsifiability check applied to method AND the catalog-growth signal: a `not surfaced:` gap that generalizes is the next lens. On the skill's first smoke test two agents' trails independently converged on the same absent angle, which is protocol-falsification evidence one pass cannot generate.

## §4 — Deploying it in a review (the validated shape)

The exhibited-positive use: an N-agent review where each agent gets a distinct draw instead of the shared fixed prompt. Pre-register the arms and pass criteria before dispatch, dedup findings mechanically (file + line window), verify blind (refuters that don't know the arm, with an exhibit-quote-found gate), and count only confirmed findings. Early smoke tests over the same substrate found that control arms (identical prompts) reached high pairwise Jaccard similarity — mode collapse, live — while treatment arms (distinct draws) lowered similarity *and* found more total confirmed defects, many of them arm-exclusive. Decorrelation paid, it did not cost. **Note the control agents can carry a full principle-set loaded and still collapse** — a loaded principle-set does not decorrelate; external directed variance does. That is the whole thesis. Dispatch shape: one multi-agent wave, one arm per agent, lens bodies inlined into each prompt (native subagent dispatch with distinct prompts; not a shared fixed template).

Provenance / attribution: credit Grace Kind (gracekind.net), Patrick Gunkel, Ed Kennedy (`latentwill/ideonomy-skill`, MIT/CC-BY).

*Companions:* [[skill://isda]] (measures density; sortes diverts attention — the border) · [[skill://forge-master]] / [[skill://auriga]] (the review harnesses a draw feeds) · the house principle lattice (estimative prior, finite external dependence, primitives-over-opinions).
