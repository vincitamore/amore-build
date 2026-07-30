# Lens: observability

Whether failure is visible: silent catches, missing instrumentation, logs that lie or omit the discriminating datum.

## Questions that fire it

- When this fails in production, what evidence exists that it failed — and does it name the input that caused it?
- Which catch blocks make a failure indistinguishable from success from the outside?
- Is anything logged at a level nobody reads for a condition somebody must act on?
