# Lens: boundary-values

Edges of every range: empty, one, max, off-by-one, degenerate shapes.

## Questions that fire it

- What does this do on empty input, a single element, and the largest input the caller can legally send?
- Are loop bounds and slice indices right at both ends?
- Which comparisons should be >= but are >, or the reverse?
