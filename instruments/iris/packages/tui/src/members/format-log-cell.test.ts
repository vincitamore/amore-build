import { describe, expect, test } from 'bun:test';
import {
  BUDGETS_EMPTY_NEVER_RAN,
  BUDGETS_EMPTY_UNAVAILABLE,
  BUDGETS_HINT,
  budgetsPanelKind,
  choreOverlayItems,
  collapseHomeInText,
  deriveLucernaUiState,
  emptyDisplayRow,
  formatBudgetPanelLines,
  formatBudgetTokenCount,
  formatChoreOverlayRow,
  formatChoresOverlayHeader,
  formatLogCell,
  formatLucernaDisplayLine,
  formatLucernaLastActionsLine,
  formatLucernaPulseStatus,
  formatPulseRefusingSubLine,
  formatPulseSubLine,
  formatResumesClock,
  formatUnknownChoreRow,
  lastActionsSummary,
  lucernaActivitySub,
  lucernaActivityValue,
  lucernaBeatAgeSub,
  parseLucernaBudgets,
  pulsePanelInnerWidth,
  tokenOverPercent,
  autoCommitMode,
  nextAutoCommitMode,
  enablementPatchForMode,
} from './lucerna-display';

const ELLIPSIS = '\u2026';
const MIDDOT = '\u00b7';

describe('formatLogCell', () => {
  test('pads short lines to width', () => {
    expect(formatLogCell('hi', 5)).toBe('hi   ');
  });

  test('truncates long lines with ellipsis (not a bare period)', () => {
    expect(formatLogCell('abcdefghij', 5)).toBe(`abcd${ELLIPSIS}`);
    expect(formatLogCell('abcdefghij', 5).endsWith(ELLIPSIS)).toBe(true);
    expect(formatLogCell('abcdefghij', 5).endsWith('.')).toBe(false);
  });

  test('preserves middle-dot separators (Pulse sibling style)', () => {
    const out = formatLogCell(`live ${MIDDOT} beat 5s`, 20);
    expect(out).toContain(MIDDOT);
    expect(out).toMatch(new RegExp(`live ${MIDDOT} beat`));
    // Must not degrade to a bare period separator.
    expect(out).not.toMatch(/live \. beat/);
  });

  test('maps multi-byte arrows/dashes but keeps middle-dot and ellipsis', () => {
    const out = formatLogCell(`a → b — c ${MIDDOT} d`, 24);
    expect(out).toContain('->');
    expect(out).toContain(MIDDOT);
    expect(out).not.toMatch(/[^\t\r\n\x20-\x7e\u00b7\u2026]/);
  });

  test('typography fallbacks (≥ arrows) and BMP pass-through (bullet, middle-dot)', () => {
    // ≥ is in the ASCII fallback table
    expect(formatLogCell('cluster ≥3', 16)).toContain('>=3');
    expect(formatLogCell('cluster ≥3', 16)).not.toContain('?');
    // list bullet is narrow BMP — pass through (not ?)
    expect(formatLogCell('  • item one', 16)).toContain('•');
    expect(formatLogCell('  • item one', 16)).not.toContain('?');
    const arrows = formatLogCell('esc · ↑↓ scroll', 24);
    expect(arrows).toContain('up');
    expect(arrows).toContain('dn');
    expect(arrows).toContain(MIDDOT);
    expect(arrows).not.toMatch(/\?/);
  });

  test('zero width → empty', () => {
    expect(formatLogCell('x', 0)).toBe('');
  });

  test('long then short: short result has no residual of long content', () => {
    const width = 40;
    const long = formatLogCell('NOTIFICATION_LONG_' + 'X'.repeat(50), width);
    const short = formatLogCell('SHORT_N', width);
    expect(long.length).toBe(width);
    expect(short.length).toBe(width);
    expect(short.startsWith('SHORT_N')).toBe(true);
    expect(short.slice('SHORT_N'.length)).toBe(' '.repeat(width - 'SHORT_N'.length));
    expect(short).not.toContain('NOTIFICATION');
    expect(short).not.toContain('XXX');
  });

  test('detail sub-line truncates mid-phrase with ellipsis at exact width', () => {
    const width = 14;
    const out = formatLogCell('Four open inbox items waiting', width);
    expect(out.length).toBe(width);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    // No bare trailing period used as the truncation marker.
    expect(out.slice(0, -1).endsWith('.')).toBe(false);
    // Full source must not remain; ellipsis marks the cut.
    expect(out).not.toContain('waiting');
  });
});

describe('collapseHomeInText (display-only tilde collapse)', () => {
  test('POSIX home prefix → tilde', () => {
    expect(collapseHomeInText('daemon start house=/home/alex/proj', '/home/alex')).toBe(
      'daemon start house=~/proj',
    );
  });

  test('Windows backslash home prefix → tilde', () => {
    const home = 'C:\\Users\\AlexMoyer';
    const line = 'daemon start house=C:\\Users\\AlexMoyer\\Documents\\house';
    expect(collapseHomeInText(line, home)).toBe('daemon start house=~\\Documents\\house');
  });

  test('Windows forward-slash form of home also collapses', () => {
    const home = 'C:\\Users\\AlexMoyer';
    const line = 'daemon start house=C:/Users/AlexMoyer/Documents/house';
    expect(collapseHomeInText(line, home)).toBe('daemon start house=~/Documents/house');
  });

  test('no home match leaves text unchanged', () => {
    expect(collapseHomeInText('beat ok', '/home/other')).toBe('beat ok');
  });

  test('formatLucernaDisplayLine applies collapse then exact width', () => {
    const out = formatLucernaDisplayLine(
      'daemon start house=/home/alex/h',
      32,
      '/home/alex',
    );
    expect(out.length).toBe(32);
    expect(out.startsWith('daemon start house=~/h')).toBe(true);
    expect(out).not.toContain('/home/alex');
  });

  test('pulse status line keeps middle-dot through display pipeline', () => {
    const out = formatLucernaDisplayLine(`live ${MIDDOT} beat 5s`, 24, '/tmp');
    expect(out.length).toBe(24);
    expect(out).toContain(`live ${MIDDOT} beat 5s`);
    expect(out).not.toMatch(/live \. beat/);
  });

  test('emptyDisplayRow is exact width spaces', () => {
    expect(emptyDisplayRow(8)).toBe('        ');
  });
});

describe('pulse sub-line width (real panel inner, not dims/3)', () => {
  test('pulsePanelInnerWidth subtracts border+pad chrome', () => {
    // Wide dash left column is agendaW capped at 48 → inner 44.
    expect(pulsePanelInnerWidth(48)).toBe(44);
    expect(pulsePanelInnerWidth(46)).toBe(42);
    expect(pulsePanelInnerWidth(10)).toBe(12); // floor
  });

  test('formatPulseSubLine at narrow panel width ends with ellipsis', () => {
    // ~46 cols is the real Pulse inner width class at 142-col terminals (agendaW 48 − chrome).
    const width = 46;
    const msg =
      'executed inbox-age-report: Four open inbox items waiting for triage this morning';
    const out = formatPulseSubLine(msg, width, '/tmp');
    expect(out.length).toBe(width);
    expect(out.startsWith('   executed')).toBe(true);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    // Full tail must not remain past the ellipsis cut.
    expect(out).not.toContain('this morning');
    // Clipped mid-phrase without ellipsis was the defect class.
    expect(out.includes('Four open inbo') && !out.includes(ELLIPSIS)).toBe(false);
  });

  test('formatPulseSubLine empty message is padded empty copy', () => {
    const out = formatPulseSubLine(null, 20, '/tmp');
    expect(out.length).toBe(20);
    expect(out.startsWith('   no notifications')).toBe(true);
    expect(out.endsWith(ELLIPSIS)).toBe(false);
  });
});

describe('deriveLucernaUiState', () => {
  const url = 'http://127.0.0.1:3853';

  test('no daemon url → daemon-down', () => {
    expect(deriveLucernaUiState(null, { available: true, lastBeat: 't' }, null)).toBe('daemon-down');
    expect(deriveLucernaUiState(undefined, null, null)).toBe('daemon-down');
  });

  test('no health and no status → stopped (loading/empty)', () => {
    expect(deriveLucernaUiState(url, null, null)).toBe('stopped');
  });

  test('available false → not-installed', () => {
    expect(deriveLucernaUiState(url, { available: false, reason: 'not-installed' }, null)).toBe(
      'not-installed',
    );
    expect(deriveLucernaUiState(url, { available: false }, null)).toBe('not-installed');
  });

  test('stale without stopped/pidAlive → stale (prior mapping)', () => {
    expect(
      deriveLucernaUiState(url, { available: true, stale: true, lastBeat: 't' }, null),
    ).toBe('stale');
  });

  test('stopped tombstone beats stale', () => {
    expect(
      deriveLucernaUiState(
        url,
        { available: true, stale: true, stopped: true, lastBeat: 't' },
        null,
      ),
    ).toBe('stopped');
  });

  test('pidAlive false beats stale', () => {
    expect(
      deriveLucernaUiState(
        url,
        { available: true, stale: true, pidAlive: false, lastBeat: 't' },
        null,
      ),
    ).toBe('stopped');
  });

  test('absent pidAlive/stopped leave stale mapping unchanged', () => {
    expect(
      deriveLucernaUiState(url, { available: true, stale: true, lastBeat: 't' }, null),
    ).toBe('stale');
  });

  test('available + lastBeat + not stale → running', () => {
    expect(
      deriveLucernaUiState(url, { available: true, lastBeat: 't', stale: false }, null),
    ).toBe('running');
  });

  test('available, no lastBeat, stale false → stopped', () => {
    expect(deriveLucernaUiState(url, { available: true, stale: false }, null)).toBe('stopped');
  });

  test('status available and not stale → running', () => {
    expect(deriveLucernaUiState(url, null, { available: true, stale: false })).toBe('running');
  });

  test('pidAlive true does not override running', () => {
    expect(
      deriveLucernaUiState(
        url,
        { available: true, lastBeat: 't', stale: false, pidAlive: true },
        null,
      ),
    ).toBe('running');
  });
});

describe('Activity Stat copy', () => {
  test('running value is Running; Hung/Stopped reserved', () => {
    expect(lucernaActivityValue('running')).toBe('Running');
    expect(lucernaActivityValue('stale')).toBe('Hung');
    expect(lucernaActivityValue('stopped')).toBe('Stopped');
  });

  test('running sub prefers status.phase then health.phase then live', () => {
    expect(lucernaActivitySub('running', { phase: 'dreaming' }, { phase: 'idle' })).toBe('dreaming');
    expect(lucernaActivitySub('running', {}, { phase: 'dreaming' })).toBe('dreaming');
    expect(lucernaActivitySub('running', {}, {})).toBe('live');
    expect(lucernaActivitySub('running', { phase: '  ' }, { phase: '' })).toBe('live');
    expect(lucernaActivitySub('stale')).toBe('stale');
    expect(lucernaActivitySub('stopped')).toBe('stopped');
  });

  test('refusing sub keeps Running value and names resume clock', () => {
    expect(lucernaActivityValue('running')).toBe('Running');
    expect(
      lucernaActivitySub('running', { phase: 'dreaming' }, {}, {
        state: 'refusing',
        resumesAt: '2026-08-13T00:00:00-05:00',
      }),
    ).toBe('refusing · resumes 00:00');
    expect(formatResumesClock('2026-08-13T14:22:00-05:00')).toBe('14:22');
  });

  test('cooling does not change the Activity Stat sub', () => {
    expect(
      lucernaActivitySub('running', { phase: 'resting' }, {}, {
        state: 'cooling',
        resumesAt: '2026-08-12T16:00:00-05:00',
      }),
    ).toBe('resting');
  });

  test('beat-age sub shows bound when present', () => {
    expect(lucernaBeatAgeSub({ lastBeat: 't', staleBoundSec: 750 })).toBe('bound 750s');
    expect(lucernaBeatAgeSub({ lastBeat: 't' })).toBe('since lastBeat');
    expect(lucernaBeatAgeSub({})).toBe('no beat');
  });
});

describe('lastActionsSummary', () => {
  test('string array keeps first entry', () => {
    expect(lastActionsSummary(['did thing'])).toBe('did thing');
  });

  test('legacy object uses action/type/name', () => {
    expect(lastActionsSummary([{ action: 'wake' }])).toBe('wake');
    expect(lastActionsSummary([{ type: 'halt' }])).toBe('halt');
  });

  test('writer shape {key, ok} renders key plus marker', () => {
    expect(lastActionsSummary([{ key: 'dream', ok: true }])).toBe('dream:ok');
    expect(lastActionsSummary([{ key: 'commit', ok: false, detail: 'x' }])).toBe('commit:fail');
    expect(lastActionsSummary([{ key: 'idle' }])).toBe('idle');
  });

  test('writer-shaped array joins up to three', () => {
    expect(
      lastActionsSummary([
        { key: 'dream', ok: true },
        { key: 'commit', ok: false },
      ]),
    ).toBe('dream:ok · commit:fail');
  });

  test('bare writer object (not array) still renders', () => {
    expect(lastActionsSummary({ key: 'dream', ok: true })).toBe('dream:ok');
  });

  test('key-list object fallback unchanged', () => {
    expect(lastActionsSummary({ a: 1, b: 2 })).toBe('a, b');
  });

  test('empty → none yet', () => {
    expect(lastActionsSummary(undefined)).toBe('none yet');
    expect(lastActionsSummary([])).toBe('none yet');
  });

  test('activity detail moves onto the last-actions line', () => {
    expect(formatLucernaLastActionsLine({ activity: 'compose', lastActions: [] })).toBe('compose');
    expect(
      formatLucernaLastActionsLine({
        activity: 'compose',
        lastActions: [{ key: 'dream', ok: true }],
      }),
    ).toBe('compose · dream:ok');
    expect(formatLucernaLastActionsLine({ lastActions: [{ key: 'dream', ok: true }] })).toBe(
      'dream:ok',
    );
  });
});

describe('formatLucernaPulseStatus', () => {
  test('null pulse is loading, not not-installed', () => {
    expect(formatLucernaPulseStatus(null, 28)).toBe('…');
    expect(formatLucernaPulseStatus(undefined, 28)).toBe('…');
  });

  test('only available === false reads not installed', () => {
    expect(formatLucernaPulseStatus({ available: false, state: 'not-installed' }, 28)).toBe(
      'not installed',
    );
    expect(formatLucernaPulseStatus({ available: true, state: 'stopped' }, 28)).toBe('stopped');
  });

  test('running without phase matches prior live · beat copy', () => {
    expect(
      formatLucernaPulseStatus({ available: true, state: 'running', beatAgeSec: 180 }, 28),
    ).toBe('live · beat 3m');
    expect(
      formatLucernaPulseStatus({ available: true, state: 'running', beatAgeSec: 12 }, 28),
    ).toBe('live · beat 12s');
  });

  test('running includes phase when it fits width', () => {
    expect(
      formatLucernaPulseStatus(
        { available: true, state: 'running', beatAgeSec: 180, phase: 'dreaming' },
        28,
      ),
    ).toBe('live · dreaming · beat 3m');
  });

  test('running drops phase when width is tight', () => {
    expect(
      formatLucernaPulseStatus(
        { available: true, state: 'running', beatAgeSec: 180, phase: 'dreaming' },
        14,
      ),
    ).toBe('live · beat 3m');
  });

  test('stale maps to hung; no local re-derivation', () => {
    expect(formatLucernaPulseStatus({ available: true, state: 'stale' }, 28)).toBe('hung');
    expect(
      formatLucernaPulseStatus(
        { available: true, state: 'running', beatAgeSec: 900, phase: 'dreaming' },
        28,
      ),
    ).toBe('live · dreaming · beat 15m');
  });

  test('pending review suffix still appends', () => {
    expect(
      formatLucernaPulseStatus(
        { available: true, state: 'stale', pendingReview: { total: 2 } },
        28,
      ),
    ).toBe('hung · 2 rev');
  });

  test('refusing width-ladder prefers reset time over review badge', () => {
    const refusing = {
      available: true,
      state: 'running',
      beatAgeSec: 12,
      capability: { state: 'refusing' as const, resumesAt: '2026-08-13T00:00:00-05:00' },
      pendingReview: { total: 3 },
    };
    expect(formatLucernaPulseStatus(refusing, 32)).toBe('refusing · resumes 00:00 · 3 rev');
    expect(formatLucernaPulseStatus(refusing, 28)).toBe('refusing · resumes 00:00');
    expect(formatLucernaPulseStatus(refusing, 24)).toBe('refusing · resumes 00:00');
    expect(formatLucernaPulseStatus(refusing, 16)).toBe('refusing · 00:00');
    expect(formatLucernaPulseStatus(refusing, 12)).toBe('refusing');
  });

  test('cooling is not a pulse token', () => {
    expect(
      formatLucernaPulseStatus(
        {
          available: true,
          state: 'running',
          beatAgeSec: 12,
          capability: { state: 'cooling', resumesAt: '2026-08-12T16:00:00-05:00' },
        },
        28,
      ),
    ).toBe('live · beat 12s');
  });

  test('stale still outranks refusing on the pulse', () => {
    expect(
      formatLucernaPulseStatus(
        {
          available: true,
          state: 'stale',
          capability: { state: 'refusing', resumesAt: '2026-08-13T00:00:00-05:00' },
        },
        28,
      ),
    ).toBe('hung');
  });
});

describe('formatPulseRefusingSubLine', () => {
  test('leads with the ceiling; chores clause only when zero and it fits', () => {
    const wide = formatPulseRefusingSubLine('233K/200K', 0, 44, '/tmp');
    expect(wide.trimEnd()).toBe('   token ceiling 233K/200K · 0 chores today');
    const mid = formatPulseRefusingSubLine('233K/200K', 0, 26, '/tmp');
    expect(mid.trimEnd()).toBe('   token ceiling 233K/200K');
    const tight = formatPulseRefusingSubLine('233K/200K', 0, 20, '/tmp');
    expect(tight.trimEnd()).toBe('   ceiling 233K/200K');
  });

  test('does not invent a chores count when actionsToday is nonzero', () => {
    const out = formatPulseRefusingSubLine('233K/200K', 3, 44, '/tmp');
    expect(out).toContain('token ceiling 233K/200K');
    expect(out).not.toContain('chores');
  });
});

describe('budgets panel display', () => {
  test('three empty states', () => {
    expect(budgetsPanelKind(undefined, false)).toBe('never-ran');
    expect(budgetsPanelKind(undefined, true)).toBe('unavailable');
    expect(budgetsPanelKind({ tokens: 100 }, true)).toBe('unavailable');
    expect(
      budgetsPanelKind({ actions: '0/12', weekly: '0/6', tokens: '0/200K' }, true),
    ).toBe('rows');
    expect(BUDGETS_EMPTY_NEVER_RAN).toContain('no cycle has run yet');
    expect(BUDGETS_EMPTY_UNAVAILABLE).toContain('budgets unavailable');
  });

  test('over-ceiling is a percent word, never clamped to 100%', () => {
    expect(tokenOverPercent(233457, 200000)).toBe('117%');
    expect(tokenOverPercent(200000, 200000)).toBeNull();
    expect(formatBudgetTokenCount(233457)).toBe('233K');
    const lines = formatBudgetPanelLines(
      {
        actions: '3/12',
        weekly: '1/6',
        tokens: '233K/200K',
        actionsToday: 3,
        dailyCap: 12,
        tokensToday: 233457,
        dailyTokenCeiling: 200000,
        windows: {
          tokens: {
            used: 233457,
            cap: 200000,
            source: 'env',
            aboveShipped: true,
            bySource: { planner: 20000, agentic: 21000, autoCommit: 192000 },
          },
        },
      },
      64,
    );
    const tokens = lines.find((l) => l.text.startsWith('tokens'));
    expect(tokens?.text).toContain('233K/200K');
    expect(tokens?.text).toContain('117%');
    expect(tokens?.text).not.toContain('100%');
    expect(tokens?.tone).toBe('warning');
    expect(tokens?.text).toContain('env !');
    expect(lines.some((l) => l.text.includes('dreams'))).toBe(true);
    expect(lines.some((l) => l.text.includes('auto-commit'))).toBe(true);
    expect(lines[lines.length - 1]?.text).toBe(BUDGETS_HINT);
  });

  test('zero counters render as normal rows', () => {
    const lines = formatBudgetPanelLines(
      {
        actions: '0/12',
        weekly: '0/6',
        tokens: '0/200K',
        actionsToday: 0,
        dailyCap: 12,
        tokensToday: 0,
        dailyTokenCeiling: 200000,
      },
      48,
    );
    expect(lines[0]?.text).toContain('0/12');
    expect(lines[1]?.text).toContain('0/6');
    expect(lines[2]?.text).toContain('0/200K');
    expect(lines[2]?.text).not.toContain('%');
  });

  test('parseLucernaBudgets ignores the old one-line shape', () => {
    expect(parseLucernaBudgets({ tokens: 100 })).toBeNull();
    expect(parseLucernaBudgets({ actions: '3/12', weekly: '1/6', tokens: '233K/200K' })).not.toBeNull();
  });
});

describe('chores overlay copy', () => {
  test('header and disabled/unknown rows', () => {
    const roster = {
      enabledCount: 7,
      shippedCount: 9,
      disabled: ['inbox-age-report', 'deploy-drift'],
      entries: [
        { key: 'survey-org', class: 'light', tier: 'daily', enabled: true, lastRun: null },
        {
          key: 'inbox-age-report',
          class: 'light',
          tier: 'daily',
          enabled: false,
          lastRun: null,
        },
      ],
    };
    expect(formatChoresOverlayHeader(roster)).toBe(
      'planner may pick 7 of 9 chores · 2 disabled',
    );
    expect(formatChoreOverlayRow(roster.entries[1], false)).toContain('planner will not pick');
    expect(formatUnknownChoreRow('deploy-drift', false)).toContain(
      'unknown — this build ships no such chore',
    );
    const items = choreOverlayItems(roster);
    expect(items.some((i) => i.kind === 'unknown' && i.key === 'deploy-drift')).toBe(true);
  });
});

describe('auto-commit mode', () => {
  test('absent enabled key is dry-run; explicit false is off', () => {
    expect(autoCommitMode({ autoCommitLive: false })).toBe('dry-run');
    expect(autoCommitMode({ autoCommitEnabled: true, autoCommitLive: false })).toBe('dry-run');
    expect(autoCommitMode({ autoCommitEnabled: true, autoCommitLive: true })).toBe('live');
    expect(autoCommitMode({ autoCommitEnabled: false, autoCommitLive: true })).toBe('off');
  });

  test('a cycles dry-run → off → live → dry-run', () => {
    expect(nextAutoCommitMode('dry-run')).toBe('off');
    expect(nextAutoCommitMode('off')).toBe('live');
    expect(nextAutoCommitMode('live')).toBe('dry-run');
  });

  test('patch for off clears live', () => {
    expect(enablementPatchForMode('off')).toEqual({
      autoCommitEnabled: false,
      autoCommitLive: false,
    });
    expect(enablementPatchForMode('live')).toEqual({
      autoCommitEnabled: true,
      autoCommitLive: true,
    });
  });
});
