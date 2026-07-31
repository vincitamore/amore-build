// Bun JSCallback trampoline page-protection repro.
// Question: can a LIVE JSCallback's trampoline page lose executability due to
// Bun-internal activity (creating/closing OTHER JSCallbacks)?
// Exhibit motivating this: a fully-live FFI callback registration whose
// trampoline page read MEM_COMMIT/PAGE_READWRITE in a crash dump (DEP execute
// violation) while nothing in the embedder had freed it.
import { dlopen, JSCallback, ptr } from "bun:ffi";

const k32 = dlopen("kernel32.dll", {
  VirtualQuery: { args: ["ptr", "ptr", "usize"], returns: "usize" },
});

const mbi = new ArrayBuffer(64);
const mbiPtr = ptr(mbi);
const dv = new DataView(mbi);
function protOf(p: number | bigint): number {
  const r = k32.symbols.VirtualQuery(p as any, mbiPtr, 64n as any);
  if (!r) return -1;
  return dv.getUint32(36, true); // MEMORY_BASIC_INFORMATION.Protect
}
const EXEC = new Set([0x10, 0x20, 0x40, 0x80]);
const fmt = (x: number) => "0x" + x.toString(16);

// measure-like signature: (ptr, f32, u32, f32, u32) -> void
const measureDef = { args: ["ptr", "f32", "u32", "f32", "u32"], returns: "void" } as const;
const voidDef = { args: [], returns: "void" } as const;

const live: JSCallback[] = [];
function mk(def: any): JSCallback {
  const cb = new JSCallback(() => {}, def);
  live.push(cb);
  return cb;
}

const A = mk(measureDef);
const p0 = protOf(A.ptr!);
console.log(`A.ptr=${fmt(Number(A.ptr))} initial Protect=${fmt(p0)} exec=${EXEC.has(p0)}`);

let flips = 0;
function checkA(phase: string, i: number) {
  const p = protOf(A.ptr!);
  if (!EXEC.has(p)) {
    flips++;
    console.log(`FLIP [${phase} #${i}]: A Protect=${fmt(p)} — LIVE callback no longer executable`);
  }
}

// Phase 2: churn creations (keep all refs — everything stays "live")
for (let i = 0; i < 300; i++) {
  mk(i % 2 ? measureDef : voidDef);
  checkA("create", i);
}

// Phase 3: close half (embedders legitimately close callbacks they no longer need)
for (let i = 1; i < live.length; i += 2) live[i].close();
checkA("after-close-half", 0);

// Phase 4: churn more creations into the freed space
for (let i = 0; i < 300; i++) {
  mk(measureDef);
  checkA("create-after-close", i);
}

// Phase 5: census — how many LIVE (never-closed) callbacks are still executable?
let dead = 0, alive = 0;
for (let i = 0; i < live.length; i += 2) { // even indices were never closed
  const cb = live[i];
  if (!cb.ptr) continue;
  const p = protOf(cb.ptr);
  if (EXEC.has(p)) alive++;
  else { dead++; if (dead <= 5) console.log(`DEAD live-callback ptr=${fmt(Number(cb.ptr))} Protect=${fmt(p)}`); }
}
console.log(`census: live-callbacks executable=${alive} NON-executable=${dead} | A-flips observed=${flips}`);
console.log(dead || flips ? "REPRODUCED: Bun deprotects live JSCallback trampolines" : "not reproduced in this run");

// ---- Phase 6: region forensics + aggressive runtime churn (GC / JIT / heap pressure) ----
function regionOf(p: number | bigint) {
  k32.symbols.VirtualQuery(p as any, mbiPtr, 64n as any);
  return {
    base: dv.getBigUint64(0, true), allocBase: dv.getBigUint64(8, true),
    allocProt: dv.getUint32(16, true), size: dv.getBigUint64(24, true),
    state: dv.getUint32(32, true), prot: dv.getUint32(36, true), type: dv.getUint32(40, true),
  };
}
const r = regionOf(A.ptr!);
console.log(`A region: allocBase=0x${r.allocBase.toString(16)} base=0x${r.base.toString(16)} size=0x${r.size.toString(16)} allocProt=${fmt(r.allocProt)} prot=${fmt(r.prot)} type=0x${r.type.toString(16)}`);

declare const Bun: any;
let phase6flips = 0;
for (let round = 0; round < 20; round++) {
  // JIT churn: force codegen
  for (let i = 0; i < 50; i++) {
    const f = new Function("x", `return x * ${i} + ${round} + Math.sin(x)`);
    let acc = 0; for (let j = 0; j < 2000; j++) acc += f(j);
  }
  // heap pressure: allocate + drop ~50MB
  let bufs: Uint8Array[] = [];
  for (let i = 0; i < 50; i++) bufs.push(new Uint8Array(1 << 20));
  bufs = [];
  Bun.gc(true);
  // more trampoline churn interleaved
  for (let i = 0; i < 20; i++) mk(measureDef);
  for (let i = live.length - 10; i < live.length; i += 2) live[i].close();
  const p = protOf(A.ptr!);
  if (!EXEC.has(p)) { phase6flips++; console.log(`FLIP [gc-round ${round}]: A Protect=${fmt(p)}`); }
}
// final census over never-closed callbacks
let dead2 = 0, alive2 = 0;
for (const cb of live) {
  if (!cb.ptr) continue;
  const p = protOf(cb.ptr);
  if (EXEC.has(p)) alive2++; else dead2++;
}
console.log(`phase6: flips=${phase6flips} · final census exec=${alive2} nonexec=${dead2}`);
console.log(dead2 || phase6flips ? "REPRODUCED under runtime churn" : "still not reproduced");
