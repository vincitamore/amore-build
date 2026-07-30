---
type: index
created: 2026-07-30
---

# tasks/

Work items for multi-session progress. Status lives in frontmatter; the folder
mirrors it so a directory listing is the queue.

## Layout

```
tasks/
├── README.md       # This file
├── *.md            # status: active | blocked (root)
├── review/         # delivered, awaiting review
├── backlog/        # admitted, not yet active
├── incubating/     # slow-cooking, below backlog priority
├── paused/         # stopped with named unpause trigger
└── completed/      # status: complete
```

Add a status value only when the corpus demands it; record the admission in
[[AGENTS]].

## Frontmatter schema

```yaml
---
type: task
status: active | blocked | review | backlog | incubating | paused | complete
created: YYYY-MM-DD
completed: null
tags: []
blocked-by: []            # when status: blocked — free-text who/what
paused: null              # date, when status: paused
paused-reason: null
trigger-to-unpause: null  # named falsifiable trigger, when paused
---
```

## Placement rules

| Status | Folder |
|--------|--------|
| `active`, `blocked` | `tasks/` (root) |
| `review` | `tasks/review/` |
| `backlog` | `tasks/backlog/` |
| `incubating` | `tasks/incubating/` |
| `paused` | `tasks/paused/` |
| `complete` | `tasks/completed/` |

Moving a file without updating `status` (or the reverse) is a lint failure.

## Discipline

- Keep the active task current while you work; the next session reads it first
  after orientation.
- Point at related inbox items and knowledge with `[[wikilinks]]`.
- On completion: set `status: complete`, `completed:`, move to
  `tasks/completed/` same-breath.
- On pause: set `paused`, `paused-reason`, and a **falsifiable**
  `trigger-to-unpause` — not "later."

Related: [[AGENTS]] · [[inbox/README]] · [[context/current-state]]
