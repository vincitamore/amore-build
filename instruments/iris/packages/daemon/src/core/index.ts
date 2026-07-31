// ─────────────────────────────────────────────────────────────────────────────
// core/ barrel — the CoreModule surface (see contract.ts::CoreModule).
// Exports EXACTLY: buildIndex, shouldExclude, serializeDoc, extractBody,
// applyChanges, startWatcher.
// Internal helpers (parseDoc, resolveTarget, buildLookupMaps, reconcile, …) are
// imported directly from their modules by tests and by sibling daemon modules.
// ─────────────────────────────────────────────────────────────────────────────

export { applyChanges, buildIndex } from './index-build';
export { shouldExclude } from './walk';
export { serializeDoc } from './serialize';
export { extractBody } from './parse';
export { startWatcher } from './watcher';
