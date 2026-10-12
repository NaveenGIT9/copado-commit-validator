import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRetry } from './queryWithRetry.mjs';

const never = () => new Promise(() => {});

test('returns the first answer without retrying', async () => {
  let calls = 0;
  const retries = [];
  const out = await withRetry(async () => { calls++; return 'ok'; }, { timeoutMs: 50, onRetry: (m) => retries.push(m) });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
  assert.equal(retries.length, 0);
});

test('a request that never answers is abandoned and the next attempt is used', async () => {
  let calls = 0;
  const retries = [];
  const started = Date.now();
  const out = await withRetry(() => (++calls === 1 ? never() : Promise.resolve('second attempt')), { timeoutMs: 40, onRetry: (m) => retries.push(m) });
  assert.equal(out, 'second attempt');
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  assert.match(retries[0], /no answer after/);
  assert.ok(Date.now() - started < 1000, 'it did not wait for the stalled request');
});

test('a request that fails is retried too', async () => {
  let calls = 0;
  const out = await withRetry(() => (++calls < 3 ? Promise.reject(new Error('socket hang up')) : Promise.resolve('third time')), { timeoutMs: 50 });
  assert.equal(out, 'third time');
  assert.equal(calls, 3);
});

test('gives up after the last attempt with the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(() => { calls++; return never(); }, { attempts: 3, timeoutMs: 20 }),
    /no answer after/,
  );
  assert.equal(calls, 3);
});

test('does not leave a timer running after a quick answer (the process can exit)', async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  await withRetry(async () => 'fast', { timeoutMs: 60_000 });
  const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.equal(after, before);
});
