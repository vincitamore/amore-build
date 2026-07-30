# Lens: configuration-reality

Config read but not applied, applied but not read, or dead: flags nothing checks, env vars shadowed by hardcodes.

## Questions that fire it

- For each config key, find the code that changes behavior when it changes — does it exist?
- Which hardcoded values duplicate (and silently override) a config knob?
- What requires a restart to take effect that the operator will assume is live?
