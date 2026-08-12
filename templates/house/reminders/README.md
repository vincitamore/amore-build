---
type: index
created: 2026-07-30
---

# reminders/

Time-based obligations. Schema is fixed so tooling and sessions share one
taxonomy.

## Status taxonomy

| Status | Meaning | Folder |
|--------|---------|--------|
| `pending` | Due in future, not yet triggered | `reminders/` |
| `snoozed` | Temporarily delayed | `reminders/` |
| `ongoing` | Recurring, active | `reminders/` |
| `completed` | Done | `reminders/completed/` |
| `dismissed` | Skipped / cancelled | `reminders/completed/` |

## Frontmatter schema

```yaml
---
type: reminder
status: pending | snoozed | ongoing | completed | dismissed
created: YYYY-MM-DD
remind-at: YYYY-MM-DDTHH:MM   # ISO datetime with time component
repeat: null | daily | weekly | monthly | custom
repeat-until: null             # ISO date
snoozed-until: null            # ISO datetime
completed: null                # date when completed/dismissed
tags: []
---
```

Required keys at minimum: `type`, `status`, `created`, `remind-at`, `tags`.
Other fields present when used.

## Arriving session surfaces due items

On arrival (before task work), surface every file with status `pending` or
`snoozed` whose `remind-at` / `snoozed-until` is ≤ now. List them in the first
reply, then proceed with orientation work.

The **SessionStart** hook automates the scan and points at due items - a prompt,
not a substitute for reading and acting. You still own fulfillment.

## Lifecycle

- **On completion / dismissal:** flip `status`, set `completed:`, move the file
  to `reminders/completed/` - same breath as the fulfilling work.
- **Repeating reminders** advance their own `remind-at` on firing (and stay
  `ongoing` / `pending` per house practice until `repeat-until` or dismissal).
- **Snooze:** set `status: snoozed` and `snoozed-until:`; the due check uses
  that field.

When scheduling tooling lands, this discipline is the tool's spec. Until then
the gap is stated, not papered over.

Related: [[AGENTS]] · [[context/current-state]]
