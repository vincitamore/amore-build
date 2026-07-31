// ─────────────────────────────────────────────────────────────────────────────
// search/ barrel — exactly the SearchModule surface (see src/contract.ts).
//
//   fuzzyMatch(text, pattern): number | null   — the SkimMatcherV2 port
//   search(index, query): IndexedDoc[]          — the legacy scoring compose
//
// The composition root (src/index.ts) imports this barrel and injects it as
// DaemonDeps.search. Nothing else is exported — the internal matrix machinery,
// case-mode helpers, and simple_match (a test-only path) stay in skim.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { SearchModule } from '../contract.ts';
import { fuzzyMatch } from './skim.ts';
import { search } from './search.ts';

export { fuzzyMatch } from './skim.ts';
export { search } from './search.ts';

// Compile-time proof the barrel matches the frozen contract surface exactly.
export const searchModule: SearchModule = { fuzzyMatch, search };
