# Lens: units-and-encodings

Quantity and representation mismatches: ms vs s, bytes vs chars, UTC vs local, paths vs URLs, normalized vs raw.

## Questions that fire it

- For each number crossing a boundary, do both sides agree on its unit?
- Where do string lengths stand in for byte lengths (or vice versa) around multi-byte content?
- Which timestamps mix zones, and which comparisons would flip near midnight or DST?
