// Idle-phase repro: does a timer-based reclaimer (libpas scavenger?) deprotect
// live JSCallback trampolines over wall-clock time?
import { dlopen, JSCallback, ptr } from "bun:ffi";

const k32 = dlopen("kernel32.dll", {
  VirtualQuery: { args: ["ptr", "ptr", "usize"], returns: "usize" },
});
const mbi = new ArrayBuffer(64);
const mbiPtr = ptr(mbi);
const dv = new DataView(mbi);
const protOf = (p: number | bigint) => {
  const r = k32.symbols.VirtualQuery(p as any, mbiPtr, 64n as any);
  return r ? dv.getUint32(36, true) : -1;
};
const EXEC = new Set([0x10, 0x20, 0x40, 0x80]);
const measureDef = { args: ["ptr", "f32", "u32", "f32", "u32"], returns: "void" } as const;

// mimic TUI scale: ~200 live measure callbacks + churn history (create/close interleave
// happened pre-round-2 in TUI history; here half get closed to leave free neighbors)
const live: JSCallback[] = [];
const closed: JSCallback[] = [];
for (let i = 0; i < 400; i++) {
  const cb = new JSCallback(() => {}, measureDef);
  if (i % 2) { cb.close(); closed.push(cb); } else live.push(cb);
}
console.log(`armed: ${live.length} live callbacks (+${closed.length} closed neighbors); watching protections for 150s`);

let lastReport = Date.now();
const t0 = Date.now();
const timer = setInterval(() => {
  let nonexec = 0;
  const flipped: string[] = [];
  for (const cb of live) {
    if (!cb.ptr) continue;
    const p = protOf(cb.ptr);
    if (!EXEC.has(p)) { nonexec++; if (flipped.length < 3) flipped.push(`0x${Number(cb.ptr).toString(16)}:prot=0x${p.toString(16)}`); }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  if (nonexec > 0) {
    console.log(`[${elapsed}s] REPRODUCED: ${nonexec}/${live.length} live trampolines NON-executable — ${flipped.join(" ")}`);
    clearInterval(timer);
    process.exit(2);
  }
  if (Date.now() - lastReport > 30_000) { console.log(`[${elapsed}s] all ${live.length} still executable`); lastReport = Date.now(); }
  if (Date.now() - t0 > 150_000) { console.log(`[${elapsed}s] not reproduced in idle window`); clearInterval(timer); process.exit(0); }
}, 1000);
// light heap tick to keep the allocator breathing without JIT storms
setInterval(() => { const b = new Uint8Array(1 << 16); b[0] = 1; }, 250);
