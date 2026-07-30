---
type: index
created: 2026-07-30
---

# inbox/

Open queue for work that is not yet a task, not yet knowledge, and not yet
resolved. Frontmatter is the source of truth; folders mirror lifecycle.

## Layout

```
inbox/
├── README.md          # This file
├── captures/          # Raw notes; triage to empty (no required lifecycle)
│   └── resolved/      # Optional parking for closed captures
├── decisions/         # Open decisions
│   └── resolved/
├── investigations/    # Open investigations
│   └── resolved/
└── ideas/             # Open ideas
    └── resolved/
```

Active folders hold the **open queue**. Terminal items live under
`inbox/<type>/resolved/`.

## Frontmatter schema

```yaml
---
type: inbox
created: YYYY-MM-DD
source: capture | operator | session
status: open | resolved | dropped | superseded
resolved: null        # date the resolving work shipped (not housekeeping day)
resolution: ""        # one line + wikilink to where it landed
---
```

`captures/` may omit `status` (no required lifecycle). If present, validate
against the same domain. Other types require `status: open` while in the
active folder.

## Lifecycle

1. **Open** — file sits in `inbox/<type>/` with `status: open` (or no status for
   captures awaiting triage).
2. **Resolve** — when work ships: set `status` to `resolved` | `dropped` |
   `superseded`, set `resolved:` (date) and `resolution:` (one line + wikilink),
   **move the file to `inbox/<type>/resolved/` in the same breath as the
   resolving work**. Never defer to a someday-triage.
3. **Same-breath rule** — resolution fields + move land with the commit (or
   the same turn) that fulfills the item. A resolved item left in the open
   folder is a defect.

## Discipline

- Prefer a decision/investigation/idea over a vague capture when the type is
  clear.
- `captures/` is a staging area — triage to a typed folder, a task, knowledge,
  or discard; do not let it accrete.
- Every document needs at least one meaningful `[[wikilink]]`.

Related: [[AGENTS]] · [[tasks/README]] · [[knowledge/README]]
