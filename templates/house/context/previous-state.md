---
type: context
created: 2026-08-03
updated: 2026-08-03
tags:
  - meta
  - state
  - archive
---

# Previous State

> Append-only archive of `current-state.md` entries, migrated when dated
> sections age past the staleness threshold or the file exceeds budget.
> Newest-first. Conditional surface — read on demand, never at session-start
> orientation. Entries are verbatim as they stood at migration; the durable
> records they point to (task files, resolved decisions, knowledge articles)
> remain authoritative.

> **Migration convention** (the lineage convention, from opus's previous-state).
> Date headings are **date of entry**, never date of migration batch. Two rules
> follow:
> 1. **Never create a duplicate heading.** When migrating a section whose
>    heading already exists here, append its entries INTO that section as a
>    labeled sub-block.
> 2. **current-state may hold compressed ≤3-line digests of entries whose full
>    bodies are already archived here.** On migration these are appended
>    verbatim as a labeled digest block rather than fuzzy-matched and dropped —
>    the archive is append-only and lossless.
>
> **Migration trigger** is either clause of current-state's entry lifecycle rule
> 3: a dated section older than ~21 days, OR the file over ~6,000 words (the
> `iris regula lint` current-state-staleness rule warns; the in-session agent
> moves).
