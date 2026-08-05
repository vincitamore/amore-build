# @amore/vinculum

Typed edge store and tier-0 structural derivation for the house graph layer.

## What it does

Walks durable house docs (`tasks/`, `inbox/`, `knowledge/`, `context/`), derives
deterministic typed edges from frontmatter and explicit body self-labels, and
writes them to `graph/edges.jsonl` at the house root. The iris daemon already
merges that file into `/api/graph?edges=semantic|both`; this package only writes.

## Tier-0 sources (no models)

| Source | Edge type |
|--------|-----------|
| Task `blocked-by:` path / wikilink | `depends-on` |
| Inbox `resolution:` wikilink | `resolved-by` |
| Body self-label `[[target]] (type)` | that type (must be one of the 15 served types) |
| Frontmatter `supersedes:` / `superseded-by:` | `supersedes` |

Edges land as `confidence: asserted` with provenance `asserted_by: structural-v0`.
Re-running `iris edges derive` reconciles: adds new structural edges, drops
structural edges whose source fact vanished, never mutates non-structural edges,
honors `graph/suppressions.jsonl`, and merges `graph/overrides.jsonl` (user note
and label win).

## Edge identity

Stable short id = first 12 hex chars of `sha256(type|source|target)` after
normalization. Collision-checked when addressing a store snapshot (id width
lengthens if needed). Used by `list` / `show` / `remove` / `edit`.

## CLI

```
iris edges derive [--house <dir>]
iris edges list [--type] [--source] [--target] [--asserted-by] [--json]
iris edges show <id>
iris edges edit <id> --note "..." | --label "..." | --clear-note | --clear-label
iris edges remove <id>
iris edges validate
iris edges stats
```

## Store

| File | Role |
|------|------|
| `graph/edges.jsonl` | Served edges |
| `graph/suppressions.jsonl` | Durable removes (re-derive will not re-create) |
| `graph/overrides.jsonl` | Durable note/label edits (merged on re-derive) |
