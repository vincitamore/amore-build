import { test, expect } from 'bun:test';
import { attentionTier, attentionWeight } from './weight';
import { statusKeyOf, axisKeyOf, type GraphNode } from './graph';

const node = (p: Partial<GraphNode>): GraphNode => ({ id: 'n', ...p });

test('attentionTier: gating task states are hot, done states are dormant', () => {
  expect(attentionTier(node({ type: 'task', status: 'blocked' }))).toBe(3);
  expect(attentionTier(node({ type: 'task', status: 'review' }))).toBe(3);
  expect(attentionTier(node({ type: 'task', status: 'active' }))).toBe(2);
  expect(attentionTier(node({ type: 'task', status: 'backlog' }))).toBe(1);
  expect(attentionTier(node({ type: 'task', status: 'complete' }))).toBe(0);
  expect(attentionTier(node({ type: 'task', status: 'paused' }))).toBe(0);
});

test('attentionTier: inbox open surfaces, resolved sinks', () => {
  expect(attentionTier(node({ type: 'inbox', status: 'open' }))).toBe(2);
  expect(attentionTier(node({ type: 'inbox', status: 'resolved' }))).toBe(0);
});

test('attentionTier: reminders active vs done', () => {
  expect(attentionTier(node({ type: 'reminder', status: 'pending' }))).toBe(2);
  expect(attentionTier(node({ type: 'reminder', status: 'completed' }))).toBe(0);
});

test('attentionTier: no status signal is neutral (identity tier)', () => {
  expect(attentionTier(node({ type: 'knowledge' }))).toBe(1);
  expect(attentionTier(node({ type: 'task' }))).toBe(1); // missing status → neutral, not urgent
  expect(attentionTier(node({ type: 'inbox' }))).toBe(1);
});

test('attentionTier: placeholders (unresolved links) are dormant', () => {
  expect(attentionTier(node({ kind: 'placeholder', type: 'knowledge' }))).toBe(0);
});

test('attentionWeight: tier dominates, degree only breaks ties within a tier', () => {
  const blockedLeaf = attentionWeight(node({ type: 'task', status: 'blocked' }), 0);
  const activeHub = attentionWeight(node({ type: 'task', status: 'active' }), 100);
  expect(blockedLeaf).toBeGreaterThan(activeHub); // a hot leaf outranks a well-connected active node

  const hub = attentionWeight(node({ type: 'task', status: 'active' }), 100);
  const leaf = attentionWeight(node({ type: 'task', status: 'active' }), 0);
  expect(hub).toBeGreaterThan(leaf); // within a tier, more links ranks inward
});

test('statusKeyOf buckets by status, falls back to type', () => {
  expect(statusKeyOf(node({ type: 'task', status: 'blocked' }))).toBe('blocked');
  expect(statusKeyOf(node({ type: 'knowledge' }))).toBe('knowledge');
});

test('axisKeyOf: status mode uses status, other modes use the cluster key', () => {
  const n = node({ type: 'task', status: 'active', group: 'tasks' });
  expect(axisKeyOf(n, 'status')).toBe('active');
  expect(axisKeyOf(n, 'cluster')).toBe('tasks');
  expect(axisKeyOf(n, 'force')).toBe('tasks');
});
