# Lens: structural-correctness

Whether the shape is right for every operation it must support over time — not just the cases exercised now. Functional adequacy verifies the sample; structural correctness verifies the space.

## Questions that fire it

- What operations will this structure have to support that current callers don't yet exercise — and does its shape still hold for those, or only for today's sample?
- Where do the module's boundaries sit relative to the axes along which it will actually change — is the likely change cheap, or does it require reshaping?
- Which invariant is held by every current code path but not guaranteed by the structure itself, so a future path can silently break it?
