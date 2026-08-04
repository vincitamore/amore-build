# Lens: naming-truth

Names that lie: getX that mutates, isX returning non-boolean, ensureX that doesn't, save that only stages.

## Questions that fire it

- Does each function do exactly what its name claims — no more (hidden side effects), no less (silent partial work)?
- Which variables' names describe what they USED to hold?
- Where would a reader acting on the name alone write a bug?
