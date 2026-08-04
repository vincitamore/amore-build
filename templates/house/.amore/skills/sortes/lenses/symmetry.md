# Lens: symmetry

Paired operations that must mirror: encode/decode, open/close, serialize/parse, add/remove, subscribe/unsubscribe.

## Questions that fire it

- For each pair, does one side handle a case the other side doesn't?
- Round-trip: does decode(encode(x)) == x for edge inputs (unicode, empty, nesting)?
- Was one side of a pair updated recently while its mirror wasn't?
