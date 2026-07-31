# Lens: permission-least

Capability held wider or longer than needed: broad tokens, world-readable files, admin paths reachable from user flows.

## Questions that fire it

- Does each operation run with the least capability that suffices?
- Which secrets/handles live longer than their one use?
- What can a caller reach through this surface that its purpose doesn't require?
