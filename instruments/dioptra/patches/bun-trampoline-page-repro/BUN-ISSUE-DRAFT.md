# DRAFT — Bun issue (do not file yet; see pre-filing checklist at bottom)

> Target repo: github.com/oven-sh/bun (bug report template)
> Status: DRAFT, holding for soak period + canary retest per pre-filing checklist.

---

## Title

`bun:ffi` JSCallback: live callback trampolines lose PAGE_EXECUTE protection under sustained workload, causing DEP access violations (Windows x64)

## What version of Bun is running?

1.3.14+0d9b296af

## What platform is your computer?

Windows 11 x64 (also observed identically across multiple process instances on the same machine; not yet tested elsewhere)

## What steps can reproduce the bug?

We have not yet reduced this to a standalone script. It reproduces reliably in a real application; minimal-churn scripts do not trigger it (details below). Reporting now because we have complete crash-dump forensics and a live non-fatal instrumentation trail that isolate the failure to trampoline page protection.

Application shape where it reproduces within minutes:

- A terminal UI app (OpenTUI + React) that registers several hundred `JSCallback`s over its lifetime as Yoga layout measure functions, signature `(ptr, f32, u32, f32, u32) -> void`, non-threadsafe.
- All JSCallbacks are strongly referenced for the life of the process and never `close()`d (we removed every close path while chasing this).
- The process also uses `node:worker_threads`, WebAssembly (web-tree-sitter), and runs at roughly 1 GB RSS.
- Interactive use (opening and closing views, which both creates new JSCallbacks and re-runs native layout over existing ones) triggers the failure within minutes.

What we observe:

1. A native layout pass calls a registered trampoline pointer and the process dies with `Segmentation fault` / STATUS_ACCESS_VIOLATION where `ExceptionInformation[0] == 8` (DEP execute violation) and `rip == fault address`. Five separate process crashes captured this way.
2. After we added a `VirtualQuery` executability check on the native side immediately before each trampoline call, the underlying event turned out to be frequent: 32+ occurrences in a few minutes of interactive use, each one a live, never-closed, strongly-referenced JSCallback whose trampoline page had transitioned to `PAGE_READWRITE`.

## What is the expected behavior?

The `ptr` of a live `JSCallback` (strongly referenced, never closed) remains callable from native code for the life of the process.

## What do you see instead?

The trampoline's page loses execute protection while the callback is still registered. Full-memory dump forensics from one fatal instance:

- Exception: `c0000005`, `Parameter[0] = 8` (execute), `rip == fault address == the registered callback pointer`.
- Memory at the fault address is a fully intact, byte-valid trampoline: prologue spilling exactly the registered signature's arguments (rcx / xmm1 / r8 / xmm3 / stack), near-calls into helper stubs on the same page, and a `mov rax, <constant>` loading a JS-side data pointer. It is the right trampoline; the page just is not executable.
- `!vprot` on the address: `MEM_COMMIT / PAGE_READWRITE / MEM_PRIVATE`, `AllocationProtect = PAGE_READWRITE` (the containing allocation was created RW and individual ranges flipped executable later).
- The failure is not one page at a time. One instrumented event showed six distinct live trampolines (entries at `...796aa2`, `...798aa2`, `...7aaaa2`, `...7b0aa2`, `...7b2aa2`, `...7b4aa2`) spanning roughly 112 KB going non-executable together, with `VirtualQuery` region sizes varying between 0x2000 and 0x4000 inside a single `AllocationBase`. That looks like a range-wide protection change over a shared arena, not an isolated page flip.
- Incidental detail that may help locate the code: for this signature the trampoline entry point always sits at page offset `0xAA2`, across processes and days. Our five historical crash addresses all end `0xAA2`.

Embedder-side causes we ruled out before pointing at the runtime:

- No `close()` is ever called (all close paths removed and verified in the shipped bundle).
- Every JSCallback is held in a module-level strong `Set` (no GC eligibility; no `FinalizationRegistry`/`WeakRef` anywhere in the dependency).
- No embedder code calls `VirtualProtect`.

What did NOT reproduce it (standalone scripts, same Bun build): creating 600+ JSCallbacks with interleaved closes; forced `Bun.gc(true)` cycles; JIT churn; 50 MB/round heap pressure; a 150-second idle watch over 200 live callbacks polling their protection each second. All stayed `PAGE_EXECUTE_READWRITE`. Whatever performs the deprotection seems to need the fuller workload (worker threads, WASM, larger heap, or sustained runtime), which is why we suspect an allocator- or JIT-adjacent code path rather than the JSCallback lifecycle itself.

## Additional information

- Working hypothesis: JSCallback trampolines are compiled into memory whose pages can later have their protection modified by another runtime component (the varying region sizes under one AllocationBase suggest a protection change applied to spans of a shared arena). If trampolines lived in dedicated executable-reserved allocations, this class would be impossible.
- Consumer-side workaround we ship: `VirtualQuery` the callback pointer before every native invocation and skip the call when the page is not executable. This converts the crash into a degraded call and is how we measured the occurrence rate.
- We can provide: symbolicated dump excerpts (registers, stack, disassembly at the fault, `!vprot` output), the instrumentation trail with timestamps and region data, and the negative-result isolation scripts. The full memory dump contains private data and cannot be shared whole, but we are happy to run any diagnostic against it or against the live workload.
- The five fatal crashes also produced `bun.report` links; we can attach those.

Investigated and written by Claude (Anthropic's model) under the operator's direction; the operator reviewed this report and can run any requested diagnostics.

---

## Pre-filing checklist (delete this section before filing)

- [ ] Soak: several days of guard-trip telemetry on v4 (rate, spread, any new pattern) — confirms the story is stable before we put it in public.
- [ ] Retest on latest Bun stable AND canary (`bun upgrade --canary`) — the isolation scripts + the TUI workload; if fixed upstream, file nothing (or file a confirmation note on an existing issue).
- [ ] Search existing issues: `JSCallback` + `access violation` / `DEP` / `trampoline` / `EXECUTE` — if a matching issue exists, comment with our forensics instead of opening a duplicate.
- [ ] Collect the bun.report crash-link(s) from `~/.dioptra/tui-crash.log` history to attach.
- [ ] Sanity-read once more for tone: plain engineering register throughout, no hype, no speculation beyond the labeled hypothesis.
- [ ] Operator sign-off, then file under the operator's GitHub account.
