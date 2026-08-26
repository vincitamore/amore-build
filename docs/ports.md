# Loopback port register

House instruments that open a network listener bind **loopback only**
(`127.0.0.1`). They are not LAN services. Override a default with the
instrument's port flag or environment variable when two processes would
otherwise collide on one machine.

Coord is the documented exception: same-seat wake stays on loopback;
cross-seat live wake is Tailnet TLS on **3856** only.

| Port | Occupant | Notes |
|------|----------|-------|
| **3853** | iris | Default index daemon port (`IRIS_PORT` / `--port`). |
| **3854–3855** | Reserved | Band for future Amore Build instrument listeners. |
| **3856** | coord | Tailnet TLS wake mux for **cross-seat only**. Bound on the Tailscale IPv4 address only (`tailscale ip -4`), never 0.0.0.0, never LAN, never this machine's own 100.x as remote. House-issued cert, TOFU pin per node. Same-seat wake does **not** use 3856: unix domain on POSIX, token-gated TCP 127.0.0.1 on Windows. |
| **3857–3859** | Reserved | Remaining band. |
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
5. **Coord 3856 is Tailnet, not loopback.** Same-seat N sessions stay on
   loopback. Cross-seat TLS binds the Tailscale IPv4 only.

## `HOUSE_COORD_DIR`

Default layout, env unset: `~/.house/coord/` is the **coord root**
(`presence/`, `seat`, `seats`, `tls/`, `inbox/`, `log/`).

`$HOUSE_COORD_DIR` is **not** one meaning across languages. Unifying the
code is deferred (a silent half-unify would isolate Python tests from
Rust/iris, or the reverse). The split:

| Consumer | `$HOUSE_COORD_DIR` means | Presence path | Coord root |
|----------|--------------------------|---------------|------------|
| Rust (`xai-grok-pager` coord) | **presence directory** | the env value | parent of that dir |
| iris daemon and TUI | **presence directory** | the env value | parent of that dir (`join(over, '..')`) |
| Python (`coord_presence.py`) | **coord root** | `$HOUSE_COORD_DIR/presence` | the env value |

Default (env unset) agrees: presence is `~/.house/coord/presence`, root is
`~/.house/coord`. Tests isolate by setting the env to a temp path of the
**matching** shape — Rust/iris `{tmp}/presence`, Python `{tmp}`. Do not
point a mixed Python+Rust process group at the same `$HOUSE_COORD_DIR`
value and expect one tree.

## See also

- [iris](iris.md) for the org index companion on 3853
- [iris-lucerna](iris-lucerna.md) for file-based Lucerna control (no Lucerna listener)
- [autonomy](autonomy.md) for Lucerna enablement defaults and kill paths
- [egress](egress.md) for when the harness or an instrument reaches the network
- [SECURITY.md](../SECURITY.md) for reporting and the autonomy summary
