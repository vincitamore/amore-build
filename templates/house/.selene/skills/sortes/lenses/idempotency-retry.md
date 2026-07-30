# Lens: idempotency-retry

What double-fires: retries around non-idempotent operations, at-least-once delivery meeting exactly-once assumptions.

## Questions that fire it

- If this runs twice with the same input (retry, replay, double-click), what duplicates or corrupts?
- Which side effects sit before the point-of-no-return check instead of after?
- Is there a dedupe key where the world can deliver duplicates — and is it actually unique?
