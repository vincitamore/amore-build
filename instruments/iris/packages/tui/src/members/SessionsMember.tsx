/**
 * Sessions member — composition point for the record surface.
 * Mounts glass stages (Probes · Usage) + SpeculumActions; owns the status strip only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { useFlash } from '../components/use-flash';
import { useStableDimensions } from '../use-stable-dimensions';
import { useMeasuredSize } from '../use-measured-size';
import { tickRender } from '../debug';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { formatLucernaDisplayLine } from './lucerna-display';
import { ProbesStage } from '../speculum/ProbesStage';
import { UsageStage } from '../speculum/UsageStage';
import { SpeculumActions } from '../speculum/SpeculumActions';
import { MicroscopeStage } from '../speculum/MicroscopeStage';
import { MapStage } from '../speculum/MapStage';
import { SearchStage } from '../speculum/SearchStage';
import { seedStageBox } from '../speculum/sessions-layout';
import {
  fetchStatusState,
  type DerivedSessionsState,
  type SessionFocus,
  INSTALL_RECIPE,
} from '../speculum/status';

type StageId = 'probes' | 'usage' | 'microscope' | 'map' | 'search';
/** Full implemented set for the chip row; exactAgenda = what the coherent gate expects. */
export const SESSION_STAGES: readonly StageId[] = ['probes', 'usage', 'microscope', 'map', 'search'];
export const STAGE_CHIP_LABEL: Record<StageId, string> = {
  probes: 'Probes',
  usage: 'Usage',
  microscope: 'Microscope',
  map: 'Map',
  search: 'Search',
};

function statusStripLine(status: DerivedSessionsState | null): string {
  if (!status) return 'loading status…';
  switch (status.state) {
    case 'not-installed':
      return `speculum not installed · ${status.detail ?? INSTALL_RECIPE}`;
    case 'error':
      return status.detail ?? 'status error';
    case 'empty':
      return status.detail ?? "no ingested sessions — run 'speculum ingest'";
    case 'ready': {
      // Prefer detail (origins + split-aware when enriched); fallback stays honest.
      if (status.detail) return status.detail;
      const o = status.origins;
      if (o) {
        let line =
          `installed · ${o.operator} operator · ${o.experiment} experiment · ${o.harness} harness`;
        if (o.unknown > 0) line += ` · ${o.unknown} unknown`;
        if (
          typeof status.primarySessions === 'number' &&
          typeof status.subagentSessions === 'number'
        ) {
          line += ` · ${status.primarySessions} primary · ${status.subagentSessions} subagent`;
        }
        return line;
      }
      if (
        typeof status.primarySessions === 'number' &&
        typeof status.subagentSessions === 'number'
      ) {
        return (
          `installed · ${status.sessions} session dirs · ` +
          `${status.primarySessions} primary · ${status.subagentSessions} subagent`
        );
      }
      return `installed · ${status.sessions} session dirs`;
    }
  }
}

/**
 * Sessions container — composition point for the record surface.
 * Five stages: Probes · Usage (glass) + Microscope · Map · Search (member-native
 * reads via the query-service). `focus` / `focusKey` is the jump seam: a jump
 * routes to the Microscope stage, which consumes it (the D7 consume-once rule).
 * `onOpenSession` is the shell's openSession spine passed to Map/Search glyphs.
 */
export function SessionsMember({
  inputActive,
  onCapture,
  focus,
  focusKey,
  onOpenSession,
}: {
  inputActive?: boolean;
  onCapture?: (b: boolean) => void;
  focus?: SessionFocus | null;
  focusKey?: number;
  onOpenSession?: (sessionId: string, opts?: { eventId?: string | number; ts?: string }) => void;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const seed = seedStageBox(dims.width, dims.height);
  const { ref: stageHostRef, width: stageW, height: stageH } = useMeasuredSize(seed);
  const stageBox = { width: stageW, height: stageH };
  const [status, setStatus] = useState<DerivedSessionsState | null>(null);
  const [stage, setStage] = useState<StageId>('probes');
  const [actionsCapture, setActionsCapture] = useState(false);
  const [searchCapture, setSearchCapture] = useState(false);
  const [flash, setFlash] = useFlash();
  const aliveRef = useRef(true);
  const lastFocusKey = useRef<number | undefined>(undefined);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshStatus = useCallback(() => {
    void fetchStatusState().then((d) => {
      if (!aliveRef.current) return;
      setStatus(d);
    });
  }, []);

  // Status strip: once on mount + on re-activation. Not a live poll (record, not watch).
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);
  useRefreshOnActive(inputActive, refreshStatus);

  // Bridge stage/actions capture (search typing, lens picker, confirm) up to the shell.
  useEffect(() => {
    onCapture?.(actionsCapture || searchCapture);
  }, [actionsCapture, searchCapture, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  // Jump spine: route a jump to the Microscope stage, which consumes it (consume-once —
  // arrowing away after the land is the Microscope's own cursor, not a fight).
  useEffect(() => {
    if (focusKey === undefined) return;
    if (focusKey === lastFocusKey.current) return;
    lastFocusKey.current = focusKey;
    if (focus?.sessionId) {
      setStage('microscope');
    }
  }, [focusKey, focus?.sessionId]);

  tickRender('SessionsMember');

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || actionsCapture || searchCapture) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    // Stage keys: plain letters (shell owns 1-9 / t v q / ctrl+n/p / s).
    if (n === 'p') {
      setStage('probes');
      return;
    }
    if (n === 'u') {
      setStage('usage');
      return;
    }
    if (n === 'm') {
      setStage('microscope');
      return;
    }
    if (n === 'g') {
      setStage('map');
      return;
    }
    if (n === 'w') {
      setStage('search');
      return;
    }
    if (n === 'tab') {
      setStage((s) => SESSION_STAGES[(SESSION_STAGES.indexOf(s) + 1) % SESSION_STAGES.length]);
      return;
    }
    // Member r refreshes the status strip only; stages own their own r handlers.
    if (n === 'r') {
      refreshStatus();
    }
  });

  const strip = statusStripLine(status);
  const stripColor =
    status?.state === 'error'
      ? t.error
      : status?.state === 'not-installed'
        ? t.warning
        : status?.state === 'empty'
          ? t.muted
          : status?.state === 'ready'
            ? t.foreground
            : t.muted;

  const rowW = Math.max(16, dims.width - 4);
  const stageActive = (id: StageId) => stage === id;
  const stageChipColor = (id: StageId) => (stageActive(id) ? t.info : t.muted);

  // Member footer owns stage keys + global i/L/A when Actions is idle.
  // While Actions captures (lens/audit/confirm), drop i/L/A so they are not duplicated.
  // Flash always wins the footer row.
  const footerHint = flash
    ? flash
    : actionsCapture
      ? 'p probes · u usage · m microscope · g map · w search · tab'
      : 'p probes · u usage · m microscope · g map · w search · tab · i ingest · L lens · A audit';

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      backgroundColor={t.background}
    >
      <Panel title="Sessions" flexShrink={0} headerRight={status?.state ?? 'loading'}>
        <text fg={stripColor} wrapMode="none">
          {formatLucernaDisplayLine(strip, rowW)}
        </text>
      </Panel>

      {/* Stage chips — all five, each with a real implementation (no coming-soon chrome). */}
      <box flexDirection="row" flexShrink={0} marginTop={1} height={1} overflow="hidden">
        {SESSION_STAGES.map((id) => (
          <box key={id} flexShrink={0} onMouseDown={() => setStage(id)} backgroundColor={t.background}>
            <text fg={stageChipColor(id)} wrapMode="none">
              {stage === id ? `· ${STAGE_CHIP_LABEL[id]} ·` : `  ${STAGE_CHIP_LABEL[id]}  `}
            </text>
          </box>
        ))}
      </box>

      {/*
        One parent-constrained host measures residual height. Keep all stages
        mounted; hide the inactive one (height 0) — never mount/unmount on switch.
      */}
      <box
        ref={stageHostRef as never}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        width="100%"
        overflow="hidden"
      >
        <box
          flexDirection="column"
          flexGrow={stage === 'probes' ? 1 : 0}
          flexShrink={stage === 'probes' ? 1 : 0}
          height={stage === 'probes' ? undefined : 0}
          minHeight={0}
          overflow="hidden"
        >
          <ProbesStage
            inputActive={!!inputActive && stage === 'probes' && !actionsCapture}
            onFlash={setFlash}
            onOpenSession={onOpenSession}
            stageBox={stageBox}
          />
        </box>
        <box
          flexDirection="column"
          flexGrow={stage === 'usage' ? 1 : 0}
          flexShrink={stage === 'usage' ? 1 : 0}
          height={stage === 'usage' ? undefined : 0}
          minHeight={0}
          overflow="hidden"
        >
          <UsageStage
            inputActive={!!inputActive && stage === 'usage' && !actionsCapture}
            onFlash={setFlash}
            stageBox={stageBox}
          />
        </box>
        <box
          flexDirection="column"
          flexGrow={stage === 'microscope' ? 1 : 0}
          flexShrink={stage === 'microscope' ? 1 : 0}
          height={stage === 'microscope' ? undefined : 0}
          minHeight={0}
          overflow="hidden"
        >
          <MicroscopeStage
            inputActive={!!inputActive && stage === 'microscope' && !actionsCapture}
            onFlash={setFlash}
            jump={focus}
            jumpKey={focusKey}
            stageBox={stageBox}
          />
        </box>
        <box
          flexDirection="column"
          flexGrow={stage === 'map' ? 1 : 0}
          flexShrink={stage === 'map' ? 1 : 0}
          height={stage === 'map' ? undefined : 0}
          minHeight={0}
          overflow="hidden"
        >
          <MapStage
            inputActive={!!inputActive && stage === 'map' && !actionsCapture}
            onFlash={setFlash}
            onOpenSession={onOpenSession}
            stageBox={stageBox}
          />
        </box>
        <box
          flexDirection="column"
          flexGrow={stage === 'search' ? 1 : 0}
          flexShrink={stage === 'search' ? 1 : 0}
          height={stage === 'search' ? undefined : 0}
          minHeight={0}
          overflow="hidden"
        >
          <SearchStage
            inputActive={!!inputActive && stage === 'search' && !actionsCapture}
            onFlash={setFlash}
            onCapture={setSearchCapture}
            onOpenSession={onOpenSession}
            stageBox={stageBox}
          />
        </box>
      </box>

      <SpeculumActions
        inputActive={!!inputActive}
        onFlash={setFlash}
        onCapture={setActionsCapture}
      />

      <box
        flexDirection="row"
        flexShrink={0}
        height={1}
        overflow="hidden"
        backgroundColor={t.background}
      >
        <text fg={flash ? t.success : t.muted} wrapMode="none">
          {formatLucernaDisplayLine(footerHint, Math.max(16, dims.width - 2))}
        </text>
      </box>
    </box>
  );
}
