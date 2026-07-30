# Lens: resource-lifetime

Acquisition/release symmetry: handles, sockets, locks, watchers, temp files, child processes.

## Questions that fire it

- For each acquire, where is the release — and does it still run on the error path?
- What happens if acquisition succeeds twice (double-open) or release runs twice (double-close)?
- Which resources outlive the scope that reasons about them?
