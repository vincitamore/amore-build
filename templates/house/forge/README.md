---
type: index
created: 2026-07-30
---

# forge/

Agent working directory for pipeline-scale orchestration and directed multi-step
products. Orchestration skills under `.selene/skills` (especially
`forge-master` and `auriga`) reference this file — keep contracts stable.

## When to use the forge pattern

- **3+ parallel agents** or **2+ pipeline layers** → full forge (handles +
  outputs + manifest in `forge/sessions/`).
- **Below threshold** → forge-lite: one `forge/output/<topic>.md`, brief summary
  at top, full analysis below. No handle, no README read for the subagent.
- **One-shot judgment** (a verdict, a triage, a single review) lives in its
  task file, not the forge. Directed deliverables the task file assigns live
  in `forge/output/` by design.

Do not reflexively apply forge to every subagent call: the pattern pays for
itself when handles serve as communication contracts between layers. No
downstream reader → no handle.

## Structure

```
forge/
├── README.md    # This file
├── handles/     # Compressed summaries for inter-agent passing (<500 words)
├── output/      # Full analyses and deliverables
└── sessions/    # Pipeline manifests ({name}.manifest.md)
```

## Conventions for subagents

Orchestrators point agents here with one line: *Read `forge/README.md` for
output conventions. Follow them exactly.*

1. **Dual-write, handle first.** `forge/handles/<name>.md` (≤500 words) THEN
   `forge/output/<name>.md`. Highest-value artifact survives a truncated run.
2. **Handle format**: heading, `**Agent:**` (with layer number),
   `**Timestamp:**`, `**Full output:**` path, `**Sources:**` if any; then Key
   Findings / Recommendations / Open Questions. Optional `**Confidence:**
   high|medium|low` with one-line rationale.
3. **Name the compression.** Compressing source into a handle applies four
   classical operations (Quintilian's *Quadripartita Ratio*): **adiectio**
   (adding context), **detractio** (omission), **transmutatio** (reordering),
   **immutatio** (substitution). Name the ones applied. Some content has
   irreducible texture (voice documents, theological language) — flag
   `**Irreducible:** <note>` instead of compressing it to death.
4. **Naming**: `layerN-concern.md`, concern = 2–4 word slug assigned by the
   orchestrator, not the agent's identity.
5. **Read lazily.** "Read X only if needed" means exactly that; context is
   finite.
6. **Cross-layer access**: default read only your designated inputs; skip-layer
   reads require explicit grant. Unspecified → restrictive (full outputs only
   when a handle leaves you unable to proceed).

## Conventions for orchestrators (main session)

- **Pass paths, not contents.** A prompt says what to read and where to write;
  payloads live in files.
- **Read handles for synthesis**; dip into full output surgically.
- **Depth cap 2** for unbroken handle-chains (handles summarizing handles);
  escape hatch: deeper layers read earlier *full outputs*, never layer-3
  handles.
- **Width 3–5 optimal**, soft limit 8–10; fan-in ~3:1 before adding an
  intermediate synthesis layer.
- **Staleness**: a handle from a prior session is suspect until checked.
- **Manifests**: any pipeline at threshold gets a
  `forge/sessions/*.manifest.md` written incrementally (topology, per-layer
  status, handle chain, outcome) with `type: forge` frontmatter — pipeline,
  recipe, goal, role, layer, triggered-by.

## Lifecycle

Track forge in git when deliverables are graded artifacts. Keep `handles/` and
`sessions/` campaign-scoped — prune them when the work they served completes,
and promote anything worth keeping to `knowledge/` or the task file.

`forge/` is for pipeline products; `type: forge` frontmatter marks pipeline-run
artifacts. Direct organizational work belongs in `inbox/captures/` — **except**
task-assigned deliverables, which live in `output/` deliberately.

Agent output is input, not verdict — verify what bears weight before promoting.

Related: [[AGENTS]] · [[knowledge/README]] · [[tasks/README]]
