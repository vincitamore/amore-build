#!/usr/bin/env bun
// sortes — draw a random lens tuple from the catalog, weighted against recent use.
//
// Usage:
//   bun pick.ts                 # default: 3 lenses
//   bun pick.ts --n 5           # bigger draw
//   bun pick.ts --print         # names only, no bodies
//   bun pick.ts --json          # machine-readable (ok-first envelope)
//   bun pick.ts --seed 42       # deterministic, no mtime side-effects
//   bun pick.ts --catalog DIR   # override catalog dir (default: ../lenses)
//
// Silent behavior (no --seed): each picked file is touched at the end. The
// picker weights against recently-touched files (1-hour half-life), so the
// catalog rotates within a session. The filesystem is the memory — no state
// file. Mechanism after latentwill/ideonomy-skill (MIT); catalog is our own.

import { readdirSync, statSync, readFileSync, utimesSync } from "fs";
import { join, basename, dirname, resolve } from "path";

const HALF_LIFE = 3600; // seconds

const argv = process.argv.slice(2);
let n = 3;
let seed: number | null = null;
let printOnly = false;
let json = false;
let catalog = resolve(dirname(Bun.main), "..", "lenses");

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case "--n":        n = parseInt(argv[++i], 10); break;
    case "--seed":     seed = parseInt(argv[++i], 10); break;
    case "--print":    printOnly = true; break;
    case "--json":     json = true; break;
    case "--catalog":  catalog = resolve(argv[++i]); break;
    case "-h": case "--help":
      console.log(readFileSync(Bun.main, "utf8").split("\n").slice(1, 15).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(0);
    default:
      console.error(`Unknown arg: ${argv[i]}`);
      process.exit(2);
  }
}

// mulberry32 — small deterministic PRNG
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed ?? (Date.now() ^ process.pid));
const weighted = seed === null;
const now = Date.now() / 1000;

let files: string[];
try {
  files = readdirSync(catalog)
    .filter(f => f.endsWith(".md") && f !== "README.md" && !f.startsWith("_"))
    .map(f => join(catalog, f));
} catch {
  const msg = `catalog not found: ${catalog}`;
  if (json) { console.log(JSON.stringify({ ok: false, error: msg })); } else { console.error(msg); }
  process.exit(1);
}
if (files.length === 0) {
  const msg = `catalog empty: ${catalog}`;
  if (json) { console.log(JSON.stringify({ ok: false, error: msg })); } else { console.error(msg); }
  process.exit(1);
}

const scored = files.map(f => {
  let penalty = 0;
  if (weighted) {
    const age = Math.max(0, now - statSync(f).mtimeMs / 1000);
    penalty = Math.exp(-age / HALF_LIFE); // ~1 just-touched, ~0 long-cold
  }
  return { f, score: rand() + penalty };
});
scored.sort((a, b) => a.score - b.score);
const picked = scored.slice(0, Math.min(n, files.length)).map(s => s.f);

if (json) {
  console.log(JSON.stringify({
    ok: true,
    picked: picked.map(f => ({ name: basename(f, ".md"), path: f, body: readFileSync(f, "utf8").trim() })),
    catalog, n: picked.length, seeded: seed !== null,
  }));
} else {
  console.log("=== SORTES LENS DRAW (this invocation) ===\n");
  for (const f of picked) console.log(`  - ${basename(f, ".md")}`);
  console.log("\n==========================================");
  if (!printOnly) {
    for (const f of picked) {
      console.log(`\n----- ${basename(f, ".md")} -----`);
      console.log(readFileSync(f, "utf8").trim());
    }
    console.log("\n[trail contract] End your artifact with a `not surfaced:` line naming the angles this draw did NOT reach. No trail, no real draw.");
  }
}

// mtime memory — picked lenses cool off. Skipped under --seed for reproducibility.
if (weighted) {
  const t = new Date();
  for (const f of picked) { try { utimesSync(f, t, t); } catch {} }
}
