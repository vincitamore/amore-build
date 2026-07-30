// ─────────────────────────────────────────────────────────────────────────────
// Structural JSON differ. Key-by-key; ARRAY ORDER IS SIGNIFICANT by default (a
// reordered array is a diff — the daemon's ordering is part of its contract).
// Ignore paths (dot-path, `*` wildcard segment) suppress ratified divergences.
// ─────────────────────────────────────────────────────────────────────────────

export type DiffKind = 'missing' | 'extra' | 'type' | 'value' | 'length';

export interface DiffResult {
  /** Dot-path to the divergence; array indices are numeric segments. */
  path: string;
  kind: DiffKind;
  /** Present on `missing`/`type`/`value`/`length`. */
  golden?: unknown;
  /** Present on `extra`/`type`/`value`/`length`. */
  target?: unknown;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Does dot-path `path` match ignore pattern `pat` (exact, prefix, or `*` segments)? */
function pathMatches(path: string, pat: string): boolean {
  if (pat === path) return true;
  // prefix: an ignored subtree (`server` ignores `server.uptime`)
  const ps = pat.split('.');
  const xs = path.split('.');
  // exact-or-prefix segment-wise match with `*` wildcard
  if (ps.length > xs.length) return false;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '*') continue;
    if (ps[i] !== xs[i]) return false;
  }
  // matched all of `pat`'s segments — `path` is the pattern or a descendant of it
  return true;
}

function isIgnored(path: string, ignore: string[]): boolean {
  return ignore.some((pat) => pathMatches(path, pat));
}

function join(base: string, seg: string | number): string {
  return base === '' ? String(seg) : `${base}.${seg}`;
}

export interface DiffOptions {
  ignore?: string[];
}

/**
 * Recursively diff `golden` against `target`. Returns an empty array iff the two
 * are structurally identical (modulo ignore paths). Objects: compares key sets
 * (missing / extra) then recurses shared keys. Arrays: a length mismatch is one
 * diff at the array path, then element-wise by index up to the shorter length.
 */
export function diffJson(golden: unknown, target: unknown, opts: DiffOptions = {}): DiffResult[] {
  const ignore = opts.ignore ?? [];
  const out: DiffResult[] = [];

  const walk = (g: unknown, t: unknown, path: string): void => {
    if (isIgnored(path, ignore)) return;

    const gt = typeOf(g);
    const tt = typeOf(t);
    if (gt !== tt) {
      out.push({ path, kind: 'type', golden: g, target: t });
      return;
    }

    if (gt === 'object') {
      const go = g as Record<string, unknown>;
      const to = t as Record<string, unknown>;
      const keys = new Set([...Object.keys(go), ...Object.keys(to)]);
      // sort for deterministic diff ordering
      for (const k of [...keys].sort()) {
        const kp = join(path, k);
        if (isIgnored(kp, ignore)) continue;
        const inG = Object.prototype.hasOwnProperty.call(go, k);
        const inT = Object.prototype.hasOwnProperty.call(to, k);
        if (inG && !inT) out.push({ path: kp, kind: 'missing', golden: go[k] });
        else if (!inG && inT) out.push({ path: kp, kind: 'extra', target: to[k] });
        else walk(go[k], to[k], kp);
      }
      return;
    }

    if (gt === 'array') {
      const ga = g as unknown[];
      const ta = t as unknown[];
      if (ga.length !== ta.length) {
        out.push({ path, kind: 'length', golden: ga.length, target: ta.length });
      }
      const n = Math.min(ga.length, ta.length);
      for (let i = 0; i < n; i++) walk(ga[i], ta[i], join(path, i));
      return;
    }

    // primitive
    if (g !== t) out.push({ path, kind: 'value', golden: g, target: t });
  };

  walk(golden, target, '');
  return out;
}
