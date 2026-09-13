import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasRunPath, waitForCanvasRun } from './runHelpers.js';
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
