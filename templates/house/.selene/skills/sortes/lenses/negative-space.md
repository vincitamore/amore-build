# Lens: negative-space

What the code conspicuously does NOT do. Treat the feature/handler matrix as a periodic grid: empty cells are predictions, not blanks.

## Questions that fire it

- Lay out the operations × cases grid — which cells are empty, and is each emptiness a decision or an omission?
- What does every sibling module have that this one lacks (logging, validation, timeout, test)?
- Which error conditions are handled everywhere except here?
