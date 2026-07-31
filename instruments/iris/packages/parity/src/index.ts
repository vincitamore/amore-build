#!/usr/bin/env bun
// parity CLI — record the legacy daemon's read surface, replay it against a target.
// ok-first --json envelope · ratified exit codes (contract.ts) · default human output.

import { resolve } from 'node:path';
import { EXIT, ok, fail, parseArgs, unknownFlags, str, num } from './contract';
import { findCommand, manifest, helpText } from './commands';
import { ENDPOINTS, endpointsByTier, tierCounts, excludeReasonCounts, type Tier } from './inventory';
import { CASES } from './cases';
import { record } from './record';
import { replay } from './replay';
import { HttpError } from './http';
import { ReplayInfraError } from './replay';
import type { CaseComparison } from './replay';

function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
function out(line = ''): void {
  process.stdout.write(line + '\n');
}

const argv = process.argv.slice(2);
const cmdName = argv[0];

if (!cmdName || cmdName === 'help' || cmdName === '--help' || cmdName === '-h') {
  out(helpText());
  process.exit(EXIT.OK);
}

const spec = findCommand(cmdName);
if (!spec) {
  const msg = `unknown command: ${cmdName}`;
  emitJson(fail('USAGE', msg, cmdName));
  process.stderr.write(`USAGE: ${msg}\n`);
  process.exit(EXIT.USAGE);
}

const parsed = parseArgs(argv.slice(1), ['json', 'quiet']);
const jsonMode = parsed.flags.json === true;
const quiet = parsed.flags.quiet === true;

// Unknown-flag policy: refuse on writes, warn on reads.
const unknown = unknownFlags(parsed.flags, spec);
if (unknown.length > 0) {
  const list = unknown.map((f) => `--${f}`).join(' ');
  if (spec.write) {
    emitJson(fail('USAGE', `Unknown flag(s) for ${spec.name}: ${list}`, spec.name));
    if (!quiet) process.stderr.write(`USAGE: unknown flag(s): ${list}\n`);
    process.exit(EXIT.USAGE);
  } else if (!quiet) {
    process.stderr.write(`warning: unknown flag(s) ignored: ${list}\n`);
  }
}

function die(code: string, message: string, exitCode: number): never {
  emitJson(fail(code, message, spec!.name));
  if (!quiet) process.stderr.write(`${code}: ${message}\n`);
  process.exit(exitCode);
}

// ── commands ────────────────────────────────────────────────────────────────
if (spec.name === 'commands') {
  if (jsonMode) emitJson(ok({ command: 'commands', ...manifest() }));
  else {
    out(helpText());
  }
  process.exit(EXIT.OK);
}

// ── inventory ───────────────────────────────────────────────────────────────
if (spec.name === 'inventory') {
  const tier = str(parsed.flags, 'tier') as Tier | undefined;
  const list = tier ? endpointsByTier(tier) : ENDPOINTS;
  const counts = tierCounts();
  if (jsonMode) {
    emitJson(ok({ command: 'inventory', counts, excludeReasons: excludeReasonCounts(), total: ENDPOINTS.length, endpoints: list }));
  } else {
    out(`inventory — ${ENDPOINTS.length} registered routes`);
    out(`  core=${counts.core}  inventory=${counts.inventory}  mutating=${counts.mutating}  excluded=${counts.excluded}`);
    const rc = excludeReasonCounts();
    out(`  excluded by reason: ${Object.entries(rc).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    out('');
    for (const e of list) {
      out(`  ${e.tier.padEnd(9)} ${e.method.padEnd(6)} ${e.path}${e.reason ? `  (${e.reason})` : ''}`);
    }
  }
  process.exit(EXIT.OK);
}

// ── cases ───────────────────────────────────────────────────────────────────
if (spec.name === 'cases') {
  if (jsonMode) emitJson(ok({ command: 'cases', count: CASES.length, cases: CASES }));
  else {
    out(`cases — ${CASES.length} recorded requests`);
    for (const c of CASES) out(`  ${c.method.padEnd(5)} ${c.path}   [${c.endpoint} · ${c.id}]`);
  }
  process.exit(EXIT.OK);
}

// ── record ──────────────────────────────────────────────────────────────────
if (spec.name === 'record') {
  const base = str(parsed.flags, 'base') ?? 'http://127.0.0.1:3847';
  const goldenDir = resolve(str(parsed.flags, 'out') ?? 'golden');
  try {
    const r = await record(base, goldenDir);
    const payload = { command: 'record', base: r.base, goldenDir: r.goldenDir, caseCount: r.caseCount, totalBytes: r.totalBytes };
    if (jsonMode) emitJson(ok(payload));
    else {
      out(`recorded ${r.caseCount} cases from ${r.base}`);
      out(`  → ${r.goldenDir}  (${r.totalBytes} bytes across ${r.caseCount} goldens + manifest)`);
    }
    process.exit(EXIT.OK);
  } catch (e) {
    if (e instanceof HttpError) {
      die(e.code === 'TIMEOUT' ? 'TIMEOUT' : 'UNAVAILABLE', e.message, e.code === 'TIMEOUT' ? EXIT.TIMEOUT : EXIT.UNAVAILABLE);
    }
    die('INTERNAL', e instanceof Error ? e.message : String(e), EXIT.INTERNAL);
  }
}

// ── replay ──────────────────────────────────────────────────────────────────
if (spec.name === 'replay') {
  const target = str(parsed.flags, 'target');
  if (!target) die('USAGE', 'replay requires --target <url>', EXIT.USAGE);
  const goldenDir = resolve(str(parsed.flags, 'golden') ?? 'golden');
  const maxDiffs = num(parsed.flags, 'max-diffs') ?? 8;
  try {
    const r = await replay(target!, goldenDir);
    if (jsonMode) {
      emitJson(ok({
        command: 'replay',
        target: r.target,
        goldenDir: r.goldenDir,
        total: r.total,
        passed: r.passed,
        failed: r.failed,
        cases: r.cases.map((c: CaseComparison) => ({
          endpoint: c.endpoint,
          id: c.id,
          path: c.path,
          pass: c.pass,
          diffs: c.diffs.slice(0, maxDiffs),
          diffCount: c.diffs.length,
        })),
      }));
    } else {
      out(`replay ${r.passed}/${r.total} passed against ${r.target}`);
      for (const c of r.cases) {
        if (c.pass) {
          out(`  PASS  ${c.path}`);
        } else {
          out(`  FAIL  ${c.path}  (${c.diffs.length} diff${c.diffs.length === 1 ? '' : 's'})`);
          for (const d of c.diffs.slice(0, maxDiffs)) {
            out(`          ${d.kind.padEnd(7)} ${d.path}`);
          }
          if (c.diffs.length > maxDiffs) out(`          … +${c.diffs.length - maxDiffs} more`);
        }
      }
    }
    process.exit(r.failed === 0 ? EXIT.OK : EXIT.ACTIONABLE);
  } catch (e) {
    if (e instanceof ReplayInfraError) die('INFRA', e.message, EXIT.INFRA);
    if (e instanceof HttpError) {
      die(e.code === 'TIMEOUT' ? 'TIMEOUT' : 'UNAVAILABLE', e.message, e.code === 'TIMEOUT' ? EXIT.TIMEOUT : EXIT.UNAVAILABLE);
    }
    die('INTERNAL', e instanceof Error ? e.message : String(e), EXIT.INTERNAL);
  }
}

// Unreachable — every command exits above.
die('INTERNAL', `command ${spec.name} not dispatched`, EXIT.INTERNAL);
