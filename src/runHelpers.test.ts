import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenFireApiError, GenFireClient } from '@genfire/sdk';
import {
  canvasRunPath,
  ISSUED_RUN_ID,
  LONG_POLL_WAIT_SECONDS,
  resolveMediaInput,
  waitForCanvasRun,
  waitForRun
} from './runHelpers.js';
import type { CanvasWorkflowRunStatus } from './runHelpers.js';
import type { publicApiRequest } from './client.js';

// A canvas run — `genfire workflow run-canvas`, and `genfire preset run`, whose
// 202 is a canvas kickoff under the caller's own instantiated copy — lives at
// `workflows/{workflowId}/runs/{runId}` and is readable ONLY under its
// workflow. Both commands used to poll `GET /v1/runs/{id}`, which looks in the
// flat run collection: a 404 `run_not_found` on the FIRST tick, after the
// server had already billed `totalCostCredits`. These tests pin the route.

const status = (over: Partial<CanvasWorkflowRunStatus> = {}): CanvasWorkflowRunStatus => ({
  runId: 'run_1',
  workflowId: 'wf_1',
  pageId: 'page_1',
  status: 'queued',
  totalCostCredits: 42,
  workflowRev: 3,
  startedAt: null,
  completedAt: null,
  error: null,
  nodes: [],
  output: { deliverables: [], intermediates: [] },
  ...over,
});

function recorder(queue: CanvasWorkflowRunStatus[]) {
  const calls: Array<{ method: string; path: string }> = [];
  const request = (async (method: string, path: string) => {
    calls.push({ method, path });
    return queue.length > 1 ? queue.shift()! : queue[0];
  }) as unknown as typeof publicApiRequest;
  return { calls, request };
}

test('waitForCanvasRun reads the run under its workflow, never /runs/{id}', async () => {
  const { calls, request } = recorder([status({ status: 'completed' })]);
  const run = await waitForCanvasRun('wf_1', 'run_1', { request });
  assert.equal(run.status, 'completed');
  assert.deepEqual(calls, [{ method: 'GET', path: '/user-workflows/wf_1/runs/run_1' }]);
  // The regression itself: the flat run route 404s for a canvas run.
  assert.ok(!calls.some((c) => c.path.startsWith('/runs/')), 'must not poll the flat run route');
});

test('waitForCanvasRun polls the same canvas route until the run is terminal', async () => {
  const { calls, request } = recorder([
    status({ status: 'queued' }),
    status({ status: 'running' }),
    status({ status: 'completed' }),
  ]);
  const run = await waitForCanvasRun('wf_1', 'run_1', { request, intervalMs: 1 });
  assert.equal(run.status, 'completed');
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.path, '/user-workflows/wf_1/runs/run_1');
});

test('a cancelled canvas run is terminal — it never comes back', async () => {
  const { calls, request } = recorder([status({ status: 'cancelled' })]);
  const run = await waitForCanvasRun('wf_1', 'run_1', { request, intervalMs: 1 });
  assert.equal(run.status, 'cancelled');
  assert.equal(calls.length, 1);
});

test('both ids are URL-encoded into the path', () => {
  assert.equal(canvasRunPath('wf/1', 'run 1'), '/user-workflows/wf%2F1/runs/run%201');
});

test('the timeout error points at `workflow run-status`, not `runs get`', async () => {
  const { request } = recorder([status({ status: 'running' })]);
  await assert.rejects(
    () => waitForCanvasRun('wf_1', 'run_1', { request, intervalMs: 1, timeoutMs: 5 }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, 'wait_timeout');
      assert.match(err.message, /genfire workflow run-status wf_1 run_1/);
      assert.ok(!/runs get/.test(err.message), 'must not send the user to the 404ing command');
      return true;
    },
  );
});

// ─── Run waiting: long-poll ──────────────────────────────────────────────────
// `GET /v1/runs/:id?wait=N` holds until the run is terminal or N seconds pass.
// A 2 s poll loop made ~135 requests for a 4.5-minute render; the long-poll
// makes ~11. Driven through a real GenFireClient with a stubbed fetch.

function runsServer(script: Array<(url: URL) => { status: number; body: unknown }>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    const step = script.length > 1 ? script.shift()! : script[0];
    const { status, body } = step(url);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const client = new GenFireClient({ apiKey: 'k', baseUrl: 'https://api.example.test/v1', fetch: fetchImpl });
  return { urls, client };
}

const apiRun = (status: string) => ({
  id: 'run_1', object: 'run', status, capability: 'video_generation', endpoint: 'videos.generations.create',
  created_at: '2026-10-11T00:00:00Z'
});

test('waitForRun reads once, then long-polls with ?wait=25 until the run is terminal', async () => {
  const { urls, client } = runsServer([
    () => ({ status: 200, body: apiRun('queued') }),
    () => ({ status: 200, body: apiRun('processing') }),
    () => ({ status: 200, body: apiRun('completed') })
  ]);
  const ticks: string[] = [];
  const run = await waitForRun(client, 'run_1', { intervalMs: 1, onTick: (r) => ticks.push(r.status) });
  assert.equal(run.status, 'completed');
  assert.deepEqual(urls, ['/v1/runs/run_1', `/v1/runs/run_1?wait=${LONG_POLL_WAIT_SECONDS}`, `/v1/runs/run_1?wait=${LONG_POLL_WAIT_SECONDS}`]);
  assert.ok(ticks.includes('queued') && ticks.at(-1) === 'completed', `ticks: ${ticks.join(',')}`);
});

test('the wait never outlasts the caller\'s own timeout', async () => {
  const { urls, client } = runsServer([() => ({ status: 200, body: apiRun('processing') })]);
  await assert.rejects(waitForRun(client, 'run_1', { intervalMs: 100, timeoutMs: 1500 }), /did not complete within/);
  const waits = urls.filter((u) => u.includes('wait=')).map((u) => Number(new URL(`https://x${u}`).searchParams.get('wait')));
  assert.ok(waits.length > 0 && waits.every((w) => w === 1), `waits: ${waits.join(',')}`);
  // An answer that comes back early still waits out the interval: no tight loop.
  assert.ok(urls.length <= 20, `${urls.length} requests in 1.5 s`);
});

test('an API that answers 400 invalid_wait gets plain polling from then on', async () => {
  const { urls, client } = runsServer([
    () => ({ status: 200, body: apiRun('queued') }),
    () => ({ status: 400, body: { type: 'about:blank', title: 'Invalid Wait', status: 400, code: 'invalid_wait', detail: 'wait must be a number', request_id: 'r' } }),
    () => ({ status: 200, body: apiRun('processing') }),
    () => ({ status: 200, body: apiRun('completed') })
  ]);
  const run = await waitForRun(client, 'run_1', { intervalMs: 1 });
  assert.equal(run.status, 'completed');
  assert.deepEqual(urls, ['/v1/runs/run_1', `/v1/runs/run_1?wait=${LONG_POLL_WAIT_SECONDS}`, '/v1/runs/run_1', '/v1/runs/run_1']);
});

test('longPoll: false keeps the plain interval polling', async () => {
  const { urls, client } = runsServer([
    () => ({ status: 200, body: apiRun('queued') }),
    () => ({ status: 200, body: apiRun('completed') })
  ]);
  await waitForRun(client, 'run_1', { intervalMs: 1, longPoll: false });
  assert.deepEqual(urls, ['/v1/runs/run_1', '/v1/runs/run_1']);
});

test('other API errors during a long-poll are not swallowed', async () => {
  const { client } = runsServer([
    () => ({ status: 200, body: apiRun('queued') }),
    () => ({ status: 404, body: { type: 'about:blank', title: 'Run Not Found', status: 404, code: 'run_not_found', detail: 'Run not found.', request_id: 'r' } })
  ]);
  await assert.rejects(waitForRun(client, 'run_1', { intervalMs: 1 }), (err: Error & { code?: string }) => err.code === 'run_not_found');
});

// ─── Media inputs that are not files ─────────────────────────────────────────
// `--ref-video IMG_1234` (Finder hides the `.MOV`) is id-shaped, and used to go
// straight to GET /runs/IMG_1234 and print an API run_not_found.

function mediaClient(getRun: (id: string) => Promise<unknown>) {
  const calls: string[] = [];
  const client = {
    async getRun(id: string) {
      calls.push(id);
      return getRun(id);
    }
  } as unknown as GenFireClient;
  return { client, calls };
}

const notFound = () => new GenFireApiError({ status: 404, code: 'run_not_found', detail: 'Run not found.' }, 404);

test('a missing file with a hidden extension is named, and no run lookup happens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genfire-media-'));
  try {
    writeFileSync(join(dir, 'IMG_1234.MOV'), 'x');
    const { client, calls } = mediaClient(async () => { throw new Error('must not look up a run'); });
    await assert.rejects(
      resolveMediaInput(client, join(dir, 'IMG_1234')),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'file_not_found');
        assert.match(err.message, /File not found: .*IMG_1234 — did you mean .*IMG_1234\.MOV\?/);
        return true;
      }
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an id-shaped value whose run lookup 404s is "neither a file nor a run", not an API error', async () => {
  const { client } = mediaClient(async () => { throw notFound(); });
  for (const value of ['IMG_9999', 'run_0123abcd', 'dash_video_abc']) {
    await assert.rejects(
      resolveMediaInput(client, value),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'media_not_found');
        assert.equal(err.message, `${value} is neither a local file nor a run on your account.`);
        return true;
      }
    );
  }
});

test('a real run id still resolves to its output; prose gets the prompt hint', async () => {
  const { client } = mediaClient(async (id) => ({
    ...apiRun('completed'), id, output: { video: { url: 'https://cdn.example/out.mp4' } }
  }));
  assert.deepEqual(await resolveMediaInput(client, 'run_abc123'), { url: 'https://cdn.example/out.mp4' });
  await assert.rejects(resolveMediaInput(client, 'make her dance'), /put it before the options/);
  assert.equal(ISSUED_RUN_ID.test('run_0123abcd'), true);
  assert.equal(ISSUED_RUN_ID.test('dash_video_abc_1'), true);
  assert.equal(ISSUED_RUN_ID.test('IMG_1234'), false);
});

test('an ISSUED run id resolves as a run even when a same-name file with an extension sits beside it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genfire-runid-'));
  const cwd = process.cwd();
  try {
    writeFileSync(join(dir, 'run_abc123.mp4'), 'x');
    writeFileSync(join(dir, 'IMG_1234.MOV'), 'x');
    process.chdir(dir);
    const ok = mediaClient(async (id) => ({ ...apiRun('completed'), id, output: { video: { url: 'https://cdn.example/out.mp4' } } }));
    assert.deepEqual(await resolveMediaInput(ok.client, 'run_abc123'), { url: 'https://cdn.example/out.mp4' });
    assert.deepEqual(ok.calls, ['run_abc123'], 'looked up as a run, not answered with "did you mean"');

    // Only when the run 404s does the sibling show up — inside the not-a-run message.
    const missing = mediaClient(async () => { throw notFound(); });
    await assert.rejects(
      resolveMediaInput(missing.client, 'run_abc123'),
      /run_abc123 is neither a local file nor a run on your account — did you mean run_abc123\.mp4\?/
    );
    // A value that is NOT an issued id still gets the sibling first, with no lookup.
    const never = mediaClient(async () => { throw new Error('must not look up a run'); });
    await assert.rejects(resolveMediaInput(never.client, 'IMG_1234'), /File not found: IMG_1234 — did you mean IMG_1234\.MOV\?/);
    assert.deepEqual(never.calls, []);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compose media goes through the same resolution (issued run ids first)', async () => {
  const { resolveComposeMedia } = await import('./commands/compose.js');
  const { client, calls } = mediaClient(async (id) => ({ ...apiRun('completed'), id, output: { video: { url: 'https://cdn.example/c.mp4' } } }));
  assert.equal(await resolveComposeMedia(client, 'dash_video_xyz'), 'https://cdn.example/c.mp4');
  assert.deepEqual(calls, ['dash_video_xyz']);
});
