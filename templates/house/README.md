---
type: index
created: 2026-07-30
---

# House scaffold

Root index for an **Amore Build** house - a continuous working tree for
long-running multi-session agent work. Continuity lives in architecture, not
in any single model's memory.

`amore-build init` plants this tree. Customize [[AGENTS]] for house identity
and local facts; keep schemas and folder roles stable so sessions and tooling
share one contract.

## Layout

| Path | Role |
|------|------|
| [[AGENTS]] | Identity, orientation ladder, schemas, session discipline |
| [[context/README\|context/]] | Dynamic state + (default-on) principle lattice |
| [[inbox/README\|inbox/]] | Open queue for captures, decisions, investigations, ideas |
| [[tasks/README\|tasks/]] | Work items by status folder |
| [[knowledge/README\|knowledge/]] | Distilled insights worth keeping across sessions |
| [[reminders/README\|reminders/]] | Time-based obligations |
| [[forge/README\|forge/]] | Pipeline products (handles, outputs, session manifests) |
| `scripts/` | House utilities (lint, orientation sync, …) |
| `.amore/` | Skills and hooks (stop gate + session init) |

## Frontmatter

Frontmatter is the single source of truth for type, status, and lifecycle.
Folder indexes (`README.md` here and under each container) use `type: index`.
Document schemas live in [[AGENTS]] and in each folder's README.

## Orientation (every session)

1. Read [[AGENTS]]
2. Read [[context/current-state]]
3. Open the active task it points to
4. Surface **due reminders** (SessionStart hook assists; you still own the check)

Then work. Before ending: update current-state if reality changed, resolve inbox
same-breath, commit with a message the next session can orient from.

Related: [[context/README]] · [[forge/README]] · [[reminders/README]]
