import { describe, expect, test } from 'bun:test';
import { resolveTypedEdgesOverlay } from './graph';

describe('resolveTypedEdgesOverlay', () => {
  test('auto ON when the house has typed edges and user has not set a preference', () => {
    expect(
      resolveTypedEdgesOverlay({ hasTypedEdges: true, configTypedEdges: 'off', userSet: false }),
    ).toBe(true);
  });

  test('auto OFF when edges are empty (file empty or absent → no served typed edges)', () => {
    expect(
      resolveTypedEdgesOverlay({ hasTypedEdges: false, configTypedEdges: 'off', userSet: false }),
    ).toBe(false);
    expect(
      resolveTypedEdgesOverlay({ hasTypedEdges: false, configTypedEdges: 'on', userSet: false }),
    ).toBe(false);
  });

  test('manual toggle wins: userSet on forces config value', () => {
    expect(
      resolveTypedEdgesOverlay({ hasTypedEdges: true, configTypedEdges: 'off', userSet: true }),
    ).toBe(false);
    expect(
      resolveTypedEdgesOverlay({ hasTypedEdges: false, configTypedEdges: 'on', userSet: true }),
    ).toBe(true);
  });
});
