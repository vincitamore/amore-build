# Lens: concurrency-interleaving

Shared state under interleaved execution: races, atomicity assumptions, check-then-act gaps.

## Questions that fire it

- Which reads assume nothing wrote between the check and the use?
- What breaks if two instances of this handler run at once?
- Which awaits open a window where the world the function captured has changed?
