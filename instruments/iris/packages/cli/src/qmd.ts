// iris qmd — managed @tobilu/qmd companion verbs (setup / status / update).
// Implementation lives in the daemon proxy; this module is the CLI facade.

import {
  QMD_PIN,
  qmdSetup,
  qmdStatus,
  qmdUpdate,
  type QmdDeps,
} from '../../daemon/src/proxies/qmd.ts';
import { type ParsedArgs, EXIT, str } from './contract';

export { QMD_PIN };

/** Shared test injection point (runner/npm stubs). */
let injectedDeps: QmdDeps | undefined;

export function setQmdTestDeps(deps: QmdDeps | undefined): void {
  injectedDeps = deps;
}

function deps(): QmdDeps {
  return injectedDeps ?? {};
}

export async function runQmdSetup(
  orgRoot: string,
  args: ParsedArgs,
): Promise<Record<string, unknown>> {
  const noModels = args.flags['no-models'] === true;
  const useGlobal = args.flags['use-global'] === true;
  const r = await qmdSetup(orgRoot, { noModels, useGlobal }, deps());
  return {
    command: 'qmd setup',
    ok: r.ok,
    pin: r.pin,
    houseId: r.houseId,
    resolveKind: r.resolveKind,
    qmdJs: r.qmdJs,
    collections: r.collections,
    models: r.models,
    steps: r.steps,
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function runQmdStatus(
  orgRoot: string,
  _args: ParsedArgs,
): Promise<Record<string, unknown>> {
  const r = await qmdStatus(orgRoot, deps());
  return { command: 'qmd status', ...r };
}

export async function runQmdUpdate(
  orgRoot: string,
  args: ParsedArgs,
): Promise<Record<string, unknown>> {
  const embed = args.flags.embed === true;
  const r = await qmdUpdate(orgRoot, { embed }, deps());
  return {
    command: 'qmd update',
    ok: r.ok,
    embed: embed,
    ...(r.embedSkipped ? { embedSkipped: r.embedSkipped } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.update
      ? { updateCode: r.update.code, updateStdout: r.update.stdout.slice(0, 500) }
      : {}),
  };
}

export function qmdExit(payload: Record<string, unknown>): number {
  if (payload.ok === false) {
    const err = String(payload.error ?? payload.reason ?? '');
    if (/not installed|not set up|not bootstrapped|required on PATH|not available/i.test(err)) {
      return EXIT.UNAVAILABLE;
    }
    return EXIT.ACTIONABLE;
  }
  if (payload.available === false && payload.state === 'not-installed') {
    return EXIT.OK; // status is informational even when missing
  }
  return EXIT.OK;
}

export function qmdStatusHuman(payload: Record<string, unknown>): string {
  const state = String(payload.state ?? 'unknown');
  const lines = [`qmd: ${state}`];
  if (payload.reason) lines.push(`  reason: ${payload.reason}`);
  if (payload.pin) lines.push(`  pin: ${payload.resolvedPin ?? payload.pin}`);
  if (payload.houseId) lines.push(`  house: ${payload.houseId}`);
  if (payload.docs !== undefined) {
    lines.push(
      `  docs: ${payload.docs}  vectors: ${payload.vectors ?? 0}  pending: ${payload.pending ?? 0}`,
    );
  }
  const models = payload.models as
    | { embedding?: boolean; rerank?: boolean; expansion?: boolean }
    | undefined;
  if (models) {
    lines.push(
      `  models: embed=${models.embedding ? 'yes' : 'no'} rerank=${models.rerank ? 'yes' : 'no'} expand=${models.expansion ? 'yes' : 'no'}`,
    );
  }
  if (payload.lastRefreshAt) lines.push(`  last refresh: ${payload.lastRefreshAt}`);
  if (payload.pendingChanges) lines.push(`  pending changes: ${payload.pendingChanges}`);
  if (payload.lastRefreshError) lines.push(`  refresh note: ${payload.lastRefreshError}`);
  return lines.join('\n');
}

export function qmdSetupHuman(payload: Record<string, unknown>): string {
  if (payload.ok === false) {
    return `qmd setup failed: ${payload.error ?? 'unknown error'}`;
  }
  const steps = Array.isArray(payload.steps) ? (payload.steps as string[]) : [];
  return [
    `qmd setup ok (pin ${payload.pin}, house ${payload.houseId})`,
    ...steps.map((s) => `  · ${s}`),
  ].join('\n');
}

/** Unused helper kept for flag parsing symmetry with other CLI modules. */
export function qmdFlagStr(args: ParsedArgs, name: string): string | undefined {
  return str(args.flags, name);
}
