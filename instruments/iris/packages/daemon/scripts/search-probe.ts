// ─────────────────────────────────────────────────────────────────────────────
// search-probe.ts — post-integration verification for /api/search parity.
//
// Fires each query at BOTH the live legacy daemon (--base, default :3847) and the
// Bun daemon (--target, default :3848), then compares the top-50 result SETS (the
// set of item paths — order is intentionally ignored, matching the parity harness
// which canonicalizes intra-tier order). Reports per-query set-equality and the
// symmetric difference. Exits 0 iff every query is set-equal.
//
// Usage:
//   bun scripts/search-probe.ts [queries...] [--target URL] [--base URL]
//
// Both daemons must be serving the SAME corpus moment (legacy freshly restarted
// so its index carries no watcher residue — see packages/daemon/README.md).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_QUERIES = [
  'sovereignty',
  'iris',
  'pipeline',
  'graph',
  'federation',
  'knowledge',
  'daemon',
  'search',
  'identity',
  'network',
  'pattern',
  'inbox',
];

interface Parsed {
  base: string;
  target: string;
  queries: string[];
}

function parseArgs(argv: string[]): Parsed {
  let base = 'http://127.0.0.1:3847';
  let target = 'http://127.0.0.1:3848';
  const queries: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') base = argv[++i];
    else if (a.startsWith('--base=')) base = a.slice('--base='.length);
    else if (a === '--target') target = argv[++i];
    else if (a.startsWith('--target=')) target = a.slice('--target='.length);
    else queries.push(a);
  }
  return { base, target, queries: queries.length > 0 ? queries : DEFAULT_QUERIES };
}

async function fetchPaths(baseUrl: string, query: string): Promise<Set<string>> {
  const url = `${baseUrl}/api/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const body = (await res.json()) as { items?: Array<{ path?: string }> };
  const set = new Set<string>();
  for (const item of body.items ?? []) {
    if (typeof item.path === 'string') set.add(item.path);
  }
  return set;
}

function diff(a: Set<string>, b: Set<string>): { onlyA: string[]; onlyB: string[] } {
  const onlyA = [...a].filter((x) => !b.has(x)).sort();
  const onlyB = [...b].filter((x) => !a.has(x)).sort();
  return { onlyA, onlyB };
}

async function main(): Promise<void> {
  const { base, target, queries } = parseArgs(process.argv.slice(2));
  console.log(`base=${base}  target=${target}  queries=${queries.length}\n`);

  let allEqual = true;
  for (const q of queries) {
    try {
      const [baseSet, targetSet] = await Promise.all([
        fetchPaths(base, q),
        fetchPaths(target, q),
      ]);
      const { onlyA, onlyB } = diff(baseSet, targetSet);
      const equal = onlyA.length === 0 && onlyB.length === 0;
      if (!equal) allEqual = false;
      const mark = equal ? 'OK  ' : 'FAIL';
      console.log(`[${mark}] q=${JSON.stringify(q)}  base=${baseSet.size} target=${targetSet.size}`);
      if (!equal) {
        if (onlyA.length) console.log(`        only in base   (${onlyA.length}): ${onlyA.join(', ')}`);
        if (onlyB.length) console.log(`        only in target (${onlyB.length}): ${onlyB.join(', ')}`);
      }
    } catch (err) {
      allEqual = false;
      console.log(`[ERR ] q=${JSON.stringify(q)}  ${(err as Error).message}`);
    }
  }

  console.log(`\n${allEqual ? 'ALL QUERIES SET-EQUAL' : 'SET DIFFERENCES FOUND'}`);
  process.exit(allEqual ? 0 : 1);
}

main();
