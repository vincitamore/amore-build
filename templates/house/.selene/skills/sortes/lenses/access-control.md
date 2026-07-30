# Lens: access-control

Whether each operation confirms who is asking and that they are allowed, before it acts — rather than assuming that from where the request arrived.

## Questions that fire it

- For each operation that changes or exposes data, does the code path confirm the caller and that they are permitted — and what happens when the caller is not established?
- Which higher-impact operations (permanent deletion, cascading changes, cross-account reads) rely only on where the request arrives rather than a confirmation in the code path?
- Is anything treated as a safeguard that is not actually such a confirmation — where a request comes from, an obscure address, a client-side setting, or cross-origin configuration?
