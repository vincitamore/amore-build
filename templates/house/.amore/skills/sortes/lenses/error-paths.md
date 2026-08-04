# Lens: error-paths

Every failure branch. The happy path is one path; the code's real surface is the union of its failure paths.

## Questions that fire it

- For each call that can fail: what actually happens when it does — propagated, swallowed, retried, half-applied?
- Which catch blocks discard the error object or replace it with a vaguer one?
- Is there a failure mode the code treats as impossible that the environment can produce (disk full, EACCES, killed mid-write)?
