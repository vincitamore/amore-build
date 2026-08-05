# graph/

Typed edge store for the house knowledge graph.

## Files

| File | Role |
|------|------|
| `edges.jsonl` | Canonical served edges — one JSON object per line. The iris daemon merges this into `/api/graph?edges=semantic` or `edges=both`. |

## Populate

Run structural derivation after authoring lifecycle fields and self-labels:

```
iris edges derive
```

Tier-0 derive reads deterministic facts from the house tree:

- task `blocked-by:` paths / wikilinks → `depends-on`
- inbox `resolution:` wikilinks → `resolved-by`
- body self-labels `[[target]] (type)` for the served type set
- frontmatter `supersedes:` / `superseded-by:`

Edges write straight into `edges.jsonl` (asserted). Re-running derive is safe:
new facts are added, vanished structural facts are dropped, hand-authored edges
are left alone.

## Review

```
iris edges list
iris edges list --type depends-on
iris edges stats
iris edges remove <src.md> <dst.md> <type>
iris edges validate
```

## Graph view

When `edges.jsonl` has typed edges, open the iris Graph member and enable typed
edges (or fetch `/api/graph?edges=semantic&shape=v2`). The overlay paints the 15
relation types in six families over the wiki link layout.
