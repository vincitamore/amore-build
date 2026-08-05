# Loopback port register

House instruments that open a network listener bind **loopback only**
(`127.0.0.1`). They are not LAN services. Override a default with the
instrument's port flag or environment variable when two processes would
otherwise collide on one machine.

| Port | Occupant | Notes |
|------|----------|-------|
| **3853** | iris | Default index daemon port (`IRIS_PORT` / `--port`). |
| **3854–3859** | Reserved | Band for future Amore Build instrument listeners. Ports in this range are assigned only when a real listener ships; do not invent placeholders. |
| **3900–3999** | CI / smoke | Ephemeral ports for automated tests (for example iris-ci daemon health). |

## Rules

1. **Default bind is loopback.** A local-first instrument must not listen on
   all interfaces unless the operator deliberately reconfigures it.
2. **One default port per instrument.** Two instruments must not ship the
   same default port on one host.
3. **Reserve, then assign.** The 3854–3859 band is held for shipped
   listeners. Until a package documents its default, the port stays free.
4. **Overrides are always available.** Document `_<NAME>_PORT` and/or
   `--port` on every listener so concurrent houses and CI can pick free
   ports without editing source.

## See also

- [iris](iris.md) for the org index companion on 3853
- [egress](egress.md) for when the harness or an instrument reaches the network
