# Lens: dependency-direction

Coupling that flows the wrong way: low layers importing high, siblings reaching into each other's internals, cycles.

## Questions that fire it

- Which imports would make a dependency diagram cyclic or upward-pointing?
- What does this module know about its callers that it shouldn't?
- Which 'shared' constant/type actually belongs to one side of the boundary?
