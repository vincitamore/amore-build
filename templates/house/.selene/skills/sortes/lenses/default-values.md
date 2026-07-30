# Lens: default-values

What defaults commit you to: unsafe fallbacks, empty-object defaults masking missing config, ?? chains hiding absence.

## Questions that fire it

- For each default, is silently-proceeding-with-it actually safer than failing loudly?
- Which defaults exist so the code runs in dev but are wrong in production?
- What distinguishes 'explicitly set to the default value' from 'never set' — and does anything downstream need to?
