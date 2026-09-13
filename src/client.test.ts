import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicApiRequest } from './client.js';

// `POST /v1/videos/timelines/{id}/renders` is gated by the API's
// `requireIdempotencyKey`, which reads the `Idempotency-Key` HEADER and nothing
// else. The render command spelled the key into the BODY as `idempotency_key`,
// where it was ignored — so every `genfire timeline render` answered 400
// `idempotency_key_required` and the command was dead on arrival.

async function captureRequest(
  run: () => Promise<unknown>,
): Promise<{ url: string; init: RequestInit }> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  let captured: { url: string; init: RequestInit } | null = null;
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ id: 'run_1', status: 'queued' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GENFIRE_API_KEY;
    else process.env.GENFIRE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GENFIRE_API_BASE_URL;
    else process.env.GENFIRE_API_BASE_URL = originalBase;
  }
  assert.ok(captured, 'fetch was called');
  return captured!;
}

test('publicApiRequest sends idempotencyKey as the Idempotency-Key HEADER', async () => {
  const { url, init } = await captureRequest(() =>
    publicApiRequest('POST', '/videos/timelines/tl_1/renders', {
      body: { mode: 'preview', rev: 2 },
      idempotencyKey: 'key-abc',
    }),
  );
  assert.equal(url, 'https://api.example.test/v1/videos/timelines/tl_1/renders');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['Idempotency-Key'], 'key-abc');
  // The body keeps `rev` (the render's own guard) and gains no key field.
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body, { mode: 'preview', rev: 2 });
  assert.ok(!('idempotency_key' in body), 'the key belongs in the header, not the body');
});

test('publicApiRequest omits the header when no key is passed', async () => {
  const { init } = await captureRequest(() =>
    publicApiRequest('GET', '/videos/timelines/tl_1'),
  );
  const headers = init.headers as Record<string, string>;
  assert.ok(!('Idempotency-Key' in headers), 'no key, no header');
});

test('timeline render passes the key as a request option, not a body field', () => {
  const src = readFileSync(new URL('./commands/timeline.ts', import.meta.url), 'utf8');
  const render = src.slice(src.indexOf("`/videos/timelines/${encodeURIComponent(timelineId)}/renders`"));
  assert.match(render.slice(0, 900), /idempotencyKey: randomUUID\(\)/, 'header option present');
  assert.ok(
    !/idempotency_key:/.test(render.slice(0, 900)),
    'a body-level idempotency_key is ignored by the route',
  );
  // The rev guard stays in the body — it is what renders actually dedupe on.
  assert.match(render.slice(0, 900), /rev: Number\(opts\.rev\)/, 'rev stays a body field');
});
