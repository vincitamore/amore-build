# Lens: cyclicity

Loops and cycles: recursion without a proven-decreasing measure, graph walks without visited-sets, event loops that re-trigger themselves.

## Questions that fire it

- For each recursion/while, what strictly decreases — and can external input make it not?
- What happens on cyclic input (self-referencing data, symlink loops, A-imports-B-imports-A)?
- Can this handler's effect emit the event it handles?
