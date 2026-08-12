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

Dreams default **off**. File: `.amore/lucerna/enable.json` with
`dreamsEnabled: true` (or an equivalent start-time OR). Absent or malformed
means false. `--force` on `lucerna dream-cycle` overrides schedule only, never
enablement, and will not run a roster-disabled chore.

## Reading budgets and the roster

Charter lives under `.amore/lucerna/`. **Read it. Do not edit it.**

| File | What it is |
|------|------------|
| `.amore/lucerna/budgets.json` | Spend caps (`dailyActionCap`, `weeklyExpensiveCap`, `cycleCooldownMinutes`, `dailyTokenCeiling`, `dreamsReserveTokens`, `autoCommitCooldownMinutes`). Precedence is argv > env > file > shipped. |
| `.amore/lucerna/chores.json` | Narrowing chore roster. Fields per key: `enabled`, `minIntervalHours` only. Unlisted keys stay enabled. |
| `.amore/lucerna/enable.json` | `dreamsEnabled` / `autoCommitLive`. |
| `instruments/lucerna/state.json` | Live counters and last cycle outcome. Display only. |

Also readable: `iris lucerna budgets` and `iris lucerna chores list|show`.

**You may not edit `budgets.json`, `chores.json`, or `enable.json`.** Those
files are operator intent. Changing them is the operator's job (`b` / `c` on
the Lucerna tab, or `iris lucerna budgets set` / `iris lucerna chores
enable|disable`). A resident that rewrites the roster or the caps is
authoring the steward's mandate.

Dreams-off is not spend-off: drafting still spends unless the operator set
`LUCERNA_AUTO_COMMIT=0`.

## Related

- `instruments/lucerna/README.md` - enablement, budgets, agentic section
- `instruments/lucerna/src/engine/dispatch-contract.md` - wall-timeout and web-off
- House `AGENTS.md` skills table
