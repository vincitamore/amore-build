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
import { tickRender } from '../debug';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { formatLucernaDisplayLine } from './lucerna-display';
import { ProbesStage } from '../speculum/ProbesStage';
import { UsageStage } from '../speculum/UsageStage';
import { SpeculumActions } from '../speculum/SpeculumActions';
import {
  fetchStatusState,
  type DerivedSessionsState,
  type SessionFocus,
  INSTALL_RECIPE,
} from '../speculum/status';

type StageId = 'probes' | 'usage';

function statusStripLine(status: DerivedSessionsState | null): string {
  if (!status) return 'loading status…';
  switch (status.state) {
    case 'not-installed':
      return `speculum not installed · ${status.detail ?? INSTALL_RECIPE}`;
    case 'error':
      return status.detail ?? 'status error';
    case 'empty':
      return status.detail ?? "no ingested sessions — run 'speculum ingest'";
    case 'ready':
      return status.detail ?? `installed · ${status.sessions} sessions`;
  }
}

/**
 * Sessions container. Props `focus` / `focusKey` are the jump seam: accepted now so a
 * future session list can consume them. When focusKey changes and sessionId is present,
 * honest behavior is a no-op flash ("session picker arrives with exploration") — no fake
 * chrome; the real jump lands when exploration mounts the picker.
 */
export function SessionsMember({
  inputActive,
  onCapture,
  focus,
  focusKey,
}: {
  inputActive?: boolean;
  onCapture?: (b: boolean) => void;
  focus?: SessionFocus | null;
  focusKey?: number;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const [status, setStatus] = useState<DerivedSessionsState | null>(null);
  const [stage, setStage] = useState<StageId>('probes');
  const [actionsCapture, setActionsCapture] = useState(false);
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

  // Bridge SpeculumActions capture (confirm / lens picker) up to the shell.
  useEffect(() => {
    onCapture?.(actionsCapture);
  }, [actionsCapture, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  // Jump spine: consume focusKey change; without a session list this is a no-op flash.
  // Comment for the exploration unit: session picker arrives with exploration.
  useEffect(() => {
    if (focusKey === undefined) return;
    if (focusKey === lastFocusKey.current) return;
    lastFocusKey.current = focusKey;
    if (focus?.sessionId) {
      setFlash('session picker arrives with exploration');
    }
  }, [focusKey, focus?.sessionId, setFlash]);

  tickRender('SessionsMember');

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || actionsCapture) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    // Stage keys: plain letters (shell owns 1-9 / t v q / ctrl+n/p).
    if (n === 'p') {
      setStage('probes');
      return;
    }
    if (n === 'u') {
      setStage('usage');
      return;
    }
    if (n === 'tab') {
      setStage((s) => (s === 'probes' ? 'usage' : 'probes'));
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

  const footerHint = flash
    ? flash
    : 'p probes · u usage · tab cycle · r status · i ingest · L lens · A audit';

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

      {/*
        Stage chips: Probes · Usage only.
        Microscope / Map / Search are omitted (not stubbed) — honor-of-absence beats
        "coming soon" chrome (tell-test honesty).
      */}
      <box flexDirection="row" flexShrink={0} marginTop={1} height={1} overflow="hidden">
        <box
          flexShrink={0}
          onMouseDown={() => setStage('probes')}
          backgroundColor={t.background}
        >
          <text fg={stageChipColor('probes')} wrapMode="none">
            {stage === 'probes' ? '· Probes ·' : '  Probes  '}
          </text>
        </box>
        <text fg={t.muted} wrapMode="none">
          {' '}
        </text>
        <box
          flexShrink={0}
          onMouseDown={() => setStage('usage')}
          backgroundColor={t.background}
        >
          <text fg={stageChipColor('usage')} wrapMode="none">
            {stage === 'usage' ? '· Usage ·' : '  Usage  '}
          </text>
        </box>
      </box>

      {/*
        Keep both stages mounted; hide the inactive one. Toggle visibility — never
        mount/unmount on stage switch (OpenTUI teardown is unsafe).
      */}
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
        />
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
