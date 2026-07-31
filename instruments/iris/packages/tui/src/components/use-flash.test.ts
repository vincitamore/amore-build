import { test, expect } from 'bun:test';
import { makeFlash } from './use-flash';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('set shows the message then clears to null after ms', async () => {
  const seen: (string | null)[] = [];
  const f = makeFlash(30, (v) => seen.push(v));
  f.set('done');
  expect(seen).toEqual(['done']);
  await sleep(60);
  expect(seen).toEqual(['done', null]);
  f.dispose();
});

test('a new message while armed resets the timer (latest wins)', async () => {
  const seen: (string | null)[] = [];
  const f = makeFlash(40, (v) => seen.push(v));
  f.set('first');
  await sleep(25); // < 40, first still showing
  f.set('second'); // re-arms
  await sleep(25); // 50ms since first, 25ms since second → still showing
  expect(seen).toEqual(['first', 'second']);
  await sleep(30); // now past 40ms since second
  expect(seen).toEqual(['first', 'second', null]);
  f.dispose();
});

test('dispose cancels a pending clear (no leaked emit)', async () => {
  const seen: (string | null)[] = [];
  const f = makeFlash(20, (v) => seen.push(v));
  f.set('leaked?');
  f.dispose();
  await sleep(40);
  expect(seen).toEqual(['leaked?']); // no trailing null
});
