---
type: index
created: 2026-07-30
---

# context/

Orientation surfaces that load at session start (or on demand). Cap
unconditional surfaces; prefer extending an existing file over inventing a new
always-on briefing. See [[AGENTS]] § Context-surface discipline.

## Contents

| File | Role | Load |
|------|------|------|
| [[context/current-state\|current-state.md]] | Standing reality - where the last session left off | Every arrival |
| [[context/previous-state\|previous-state.md]] | Append-only archive of migrated current-state sections | On demand |
| [[context/principle-lattice\|principle-lattice.md]] | Normative judgment lens (default-on) | Orientation; may be omitted via `init --no-lattice` |

## Schema notes

- **current-state** is dynamic state, not doctrine. The session that changes
  reality updates it before ending. New changes land under
  `## Recent structural changes (DATE)`; the word budget is the lineage ceiling
  (~6,000, matching `iris regula lint`) - raise deliberately, never silently.
- **previous-state** is the append-only archive. Dated sections migrate here
  verbatim (newest-first) when they age past ~21 days or the file passes
  budget; never edited in place.
- **principle-lattice** is curated, not accumulated by default. Admission, demotion, and
  revision rules live in the file under "Lattice curation discipline."
- Do not dump task lists or inbox queues here - those have their own folders.
  Point at them from current-state with paths/wikilinks.

Optional later surfaces (voice, project map, praxis) need **(a)** a role no
existing file can carry and **(b)** an explicit unconditional/conditional
decision with a named trigger.

Related: [[AGENTS]] · [[context/current-state]] · [[context/principle-lattice]]
