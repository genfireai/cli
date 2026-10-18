import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenFireApiError } from '@genfire/sdk';
import {
  CLI_AUTH_POLL_INTERVAL_MS,
  CLI_AUTH_POLL_MAX_MS,
  CLI_AUTH_RETRY_BACKOFF_MS,
  parseRetryAfterMs,
  pollCliAuthSession
} from './cliAuthPoll.js';
import type { CliAuthPollRetry } from './cliAuthPoll.js';

// `genfire auth login` polls the session while the user approves in the
// browser. It used to throw on the first 429 — and the status route shared the
// 20/min token bucket, so an approval slower than ~40 s killed the login. These
// tests drive the real SDK call through a scripted transport and a fake clock.

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

const SESSION_ID = 'AbCdEfGhIjKlMnOpQrSt';
const session = (status: string) => ({
  session_id: SESSION_ID,
  status,
  label: 'genfire-cli (test)',
  requested_scopes: ['account:read'],
  expires_at: '2026-10-16T12:10:00.000Z'
});
const problem = (status: number, code: string) => ({
  type: `https://api.genfire.ai/errors/${code}`,
  title: code,
  status,
  detail: code,
  code,
  request_id: 'req_test'
});

function harness(replies: Reply[]) {
  let clock = 0;
  const sleeps: number[] = [];
  const urls: string[] = [];
  const retries: CliAuthPollRetry[] = [];
  let pendingNotices = 0;
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    urls.push(String(input));
    // The last reply repeats once the script runs out.
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) }
    });
  };
  const run = (overrides: { timeoutMs?: number } = {}) => pollCliAuthSession(SESSION_ID, {
    baseUrl: 'https://api.test/v1',
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    onPending: () => { pendingNotices += 1; },
    onRetry: (retry) => { retries.push(retry); },
    ...overrides
  });
  return { run, sleeps, urls, retries, pendingNotices: () => pendingNotices, elapsed: () => clock };
}

test('a 429 mid-approval is waited out (Retry-After honoured), then the approval lands', async () => {
  const h = harness([
    { status: 200, body: session('pending') },
    { status: 429, body: problem(429, 'rate_limited'), headers: { 'retry-after': '30' } },
    { status: 200, body: session('approved') }
  ]);

  assert.equal(await h.run(), 'approved');
  assert.equal(h.urls.length, 3);
  assert.ok(h.urls.every((url) => url === `https://api.test/v1/cli/auth/sessions/${SESSION_ID}`));
  // Normal cadence after `pending`, then exactly the server's Retry-After.
  assert.deepEqual(h.sleeps, [CLI_AUTH_POLL_INTERVAL_MS, 30_000]);
  assert.equal(h.retries.length, 1);
  assert.equal(h.retries[0].reason, 'rate_limited');
  assert.equal(h.pendingNotices(), 1);
});

test('a 429 without Retry-After backs off, and never polls faster than the normal cadence', async () => {
  const h = harness([
    { status: 429, body: problem(429, 'rate_limited') },
    { status: 429, body: problem(429, 'rate_limited'), headers: { 'retry-after': '0' } },
    { status: 200, body: session('approved') }
  ]);

  assert.equal(await h.run(), 'approved');
  assert.equal(h.sleeps[0], CLI_AUTH_RETRY_BACKOFF_MS);
  assert.ok(h.sleeps[0] > CLI_AUTH_POLL_INTERVAL_MS, 'a throttle waits longer than a normal tick');
  assert.equal(h.sleeps[1], CLI_AUTH_POLL_INTERVAL_MS, 'Retry-After: 0 still waits one tick');
  assert.deepEqual(h.retries.map((r) => r.consecutiveFailures), [1, 2]);
});

test('5xx and network failures are transient, not fatal', async () => {
  const h = harness([
    { status: 503, body: problem(503, 'public_api_storage_unavailable') },
    new TypeError('fetch failed'),
    { status: 502 }, // empty body
    { status: 200, body: session('pending') },
    { status: 200, body: session('approved') }
  ]);

  assert.equal(await h.run(), 'approved');
  assert.deepEqual(h.retries.map((r) => r.reason), ['transient', 'transient', 'transient']);
  assert.ok(h.sleeps.slice(0, 3).every((ms) => ms === CLI_AUTH_RETRY_BACKOFF_MS));
  assert.equal(h.retries[2].consecutiveFailures, 3);
});

test('a proxy HTML error page (the SDK JSON.parse throws SyntaxError) keeps polling', async () => {
  let calls = 0;
  const pending = pollCliAuthSession(SESSION_ID, {
    baseUrl: 'https://api.test/v1',
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })
        : new Response(JSON.stringify(session('approved')), { status: 200 });
    },
    now: () => 0,
    sleep: async () => {}
  });
  assert.equal(await pending, 'approved');
  assert.equal(calls, 2);
});

test('the deadline ends a login nobody approves as expired, without sleeping past it', async () => {
  const timeoutMs = 60_000;
  const h = harness([
    { status: 200, body: session('pending') },
    { status: 429, body: problem(429, 'rate_limited'), headers: { 'retry-after': '3600' } },
    { status: 200, body: session('pending') }
  ]);

  assert.equal(await h.run({ timeoutMs }), 'expired');
  assert.equal(h.elapsed(), timeoutMs, 'stops at the deadline, not after it');
  assert.ok(h.sleeps.every((ms) => ms > 0));
});

test('an approval that lands during the last, deadline-capped wait still logs in', async () => {
  const timeoutMs = 60_000;
  const h = harness([
    { status: 200, body: session('pending') },
    { status: 429, body: problem(429, 'rate_limited'), headers: { 'retry-after': '3600' } },
    { status: 200, body: session('approved') }
  ]);

  assert.equal(await h.run({ timeoutMs }), 'approved');
  assert.equal(h.elapsed(), timeoutMs, 'the final look happens at the deadline, with no extra sleep');
});

test('the default deadline is the full session lifetime even when every poll is throttled', async () => {
  const h = harness([{ status: 429, body: problem(429, 'rate_limited') }]);

  assert.equal(await h.run(), 'expired');
  assert.equal(h.elapsed(), CLI_AUTH_POLL_MAX_MS);
  assert.ok(h.retries.length > 1, 'kept polling through the throttle');
});

test('not-found, denied and expired end the login exactly as before', async () => {
  const notFound = harness([{ status: 404, body: problem(404, 'cli_session_not_found') }]);
  await assert.rejects(notFound.run(), (err: unknown) => err instanceof GenFireApiError && err.status === 404);
  assert.equal(notFound.urls.length, 1, 'a missing session is never retried');

  assert.equal(await harness([{ status: 200, body: session('denied') }]).run(), 'denied');
  assert.equal(await harness([{ status: 200, body: session('expired') }]).run(), 'expired');
});

test('the cadence fits even the old 20/min token bucket the status route used to share', () => {
  assert.ok(60_000 / CLI_AUTH_POLL_INTERVAL_MS <= 20);
  assert.ok(CLI_AUTH_RETRY_BACKOFF_MS >= CLI_AUTH_POLL_INTERVAL_MS);
});

test('Retry-After parses delta-seconds and HTTP dates', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  assert.equal(parseRetryAfterMs('12', now), 12_000);
  assert.equal(parseRetryAfterMs('Fri, 16 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfterMs('Fri, 16 Oct 2026 11:00:00 GMT', now), 0);
  assert.equal(parseRetryAfterMs('soon', now), null);
  assert.equal(parseRetryAfterMs(null, now), null);
});
