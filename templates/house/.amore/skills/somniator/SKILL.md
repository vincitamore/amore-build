---
name: somniator
description: "Dream review and agentic-dream contracts for Lucerna. Use when reviewing dream manifests (review-status pending), applying or closing forge proposals, reading forge/dreams sessions, or running supervised self-orient / agentic-housekeeping cycles. Load before multi-turn dream review work. SKIP plain org CRUD; SKIP operator forge pipelines under forge/sessions/ (those are forge-master)."
---

# somniator - dream review for Lucerna

Lucerna may run autonomous light and agentic dreams when the house has
`dreamsEnabled` set. This skill teaches a resident agent how to review those
artifacts without treating them as auto-applied changes.

## Path map

```
forge/
├── dreams/
│   ├── {ts}-{action}.md              # light + agentic reports
│   └── sessions/
│       └── {YYYYMMDD-HHmmss}-{action}.manifest.md
└── proposals/
    └── {slug}.md                     # status: pending | applied | closed
```

| Artifact | Pending signal | Resident verb |
|----------|----------------|---------------|
| Light / agentic report | `status: pending` | Read findings; set `status: acted` when processed |
| Dream pipeline manifest | `review-status: pending` | Review body; set `review-status: reviewed` |
| Proposal | `status: pending` | Apply carefully or close; flip status |

## Manifest review

Manifest path shape:

`forge/dreams/sessions/<YYYYMMDD-HHmmss>-<action>.manifest.md`

Frontmatter includes `type: forge`, `pipeline: dream-<action>`, `recipe: dream`,
`triggered-by: dream`, and `review-status: pending`.

**What `review-status: pending` means:** the cycle finished and left work for a
resident. The body lists what ran, what was read, and what was produced. If a
governance breach section is present, treat that as blocking: inspect the named
paths, remediate by hand if needed, then review. Lucerna does not auto-revert
out-of-bounds writes.

**How to mark reviewed:** edit the manifest frontmatter in place and set
`review-status: reviewed`. Do not delete the manifest; keep the audit trail.

## Proposal handling

Proposal path: `forge/proposals/<slug>.md`.

Frontmatter:

```yaml
type: proposal
status: pending
created: 'YYYY-MM-DD'
triggered-by: dream
title: "<one line>"
target: <relative path>
```

Proposals are **doc-only**. Lucerna never applies them. A resident:

1. Reads the proposed change and rationale.
2. If accepting, applies the change under operator authority to the `target`
   (especially when the target is protected), then sets `status: applied`.
3. If rejecting or obsolete, sets `status: closed`.

Do not auto-apply `AGENTS.md`, `context/`, `knowledge/`, or other protected
surfaces from a dream agent.

## Agentic actions (reference)

| Key | Class | Role |
|-----|-------|------|
| `self-orient` | agentic | Orientation report + proposals |
| `agentic-housekeeping` | agentic | Tidy survey, report-and-propose |
| `edges-update` | light shell | `iris edges update --tier 0 --json` |
| `edges-densify` | expensive shell | `iris edges update --tier 2 --json` |

Agentic loops write only under `forge/`, `inbox/captures/`, and Lucerna runtime.
Web tools are disabled for maintenance dreams. Wall-timeout tree-kill applies.

## Enablement

Dreams default **off**. File: `instruments/lucerna/lucerna.enable.json` with
`dreamsEnabled: true` (or an equivalent start-time OR). Absent or malformed
means false. `--force` on `lucerna dream-cycle` overrides schedule only, never
enablement.

## Related

- `instruments/lucerna/README.md` - enablement, budgets, agentic section
- `instruments/lucerna/src/engine/dispatch-contract.md` - wall-timeout and web-off
- House `AGENTS.md` skills table
