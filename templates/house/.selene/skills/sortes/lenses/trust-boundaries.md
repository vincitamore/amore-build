# Lens: trust-boundaries

Where unvalidated data crosses into trusted operations: parsers, interpolations, paths, spawns.

## Questions that fire it

- Trace each external input to its first use in a query, path, command, or eval — what sanitizes it en route?
- Which internal function trusts its arguments because 'only we call it' — and is that still true?
- What could a malformed or unexpected filename, header, or config value cause this to do?
