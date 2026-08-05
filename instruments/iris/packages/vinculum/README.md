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
structural edges whose source fact vanished, and never mutates non-structural edges.

## CLI

```
iris edges derive [--house <dir>]
iris edges list [--type <type>]
iris edges remove <src> <dst> <type>
iris edges validate
iris edges stats
```

## Store

`graph/edges.jsonl` — one JSON object per line. Schema fields match what the
daemon expects (`source`, `target`, `type`, `confidence`, `refines_wikilink`)
plus full provenance (`evidence`, `verify_key`, `provenance`) for freshness
and review later.
