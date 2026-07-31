# Skills

A skill is a document that teaches the agent a discipline it should apply
consistently, instead of re-deriving it every session. These six are bundled as
a starting set. They are yours now — edit them, replace them, delete the ones
you do not use.

## How they load

The harness scans `.arcus/skills/` in your house, plus `~/.arcus/skills` for
anything you want available everywhere. Each skill is a directory containing a
`SKILL.md` whose frontmatter carries a `name` and a `description`.

Only the **descriptions** are loaded at session start — a short index of what
exists. The body is read on demand, when the agent judges the skill relevant or
when you ask for it by name. That is why the description matters most: it is the
trigger. A description that does not say clearly when to use the skill, and when
*not* to, will not fire at the right moment.

Subagents inherit whatever the parent session discovered.

## What is here

| Skill | What it is for |
|---|---|
| `forge-master` | Running several agents in parallel over one question, and combining what they return |
| `auriga` | Driving a large batch of similar work units under an explicit budget |
| `oeconomia` | Deciding what to delegate and to which model tier, so the expensive context stays lean |
| `prokope` | Keeping a long, multi-session goal on course — and noticing when it has drifted |
| `sortes` | Drawing decorrelated review lenses so parallel reviewers do not all find the same thing |
| `isda` | Measuring how much a piece of text can be compressed without losing what it carries |

## Writing your own

Copy the shape of one of these. The parts that matter:

- **`description`** — when to load this, when to skip it, and what it is *not*.
  Write it for a reader deciding whether to open the file.
- **A self-maintenance note** — what would make this skill stale, and what to
  update when that happens. A skill nobody revises becomes a document that
  confidently describes a system that no longer exists.
- **Concrete instructions over principles.** The agent already reasons; what it
  lacks is your specific practice.

Keep assets inside the skill's own directory and reference them by relative
path.

## A note on the principle lattice

`.arcus/rules/principle-lattice.md` is a different thing from a skill: it loads
in full, every session, as a standing lens rather than on-demand guidance. The
copy planted here is **a worked example, not a prescription** — it is one house's
set of commitments, written down so the agent can apply them consistently.

Read it, and then make it yours: rewrite the entries that do not match how you
work, delete the ones you do not hold, add the ones you do. An inherited lattice
you have not examined is worse than none, because it will be applied to your
work as though you had chosen it.

If you would rather not have one at all, `arcus init --no-lattice` skips it.
