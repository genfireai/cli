import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenFireApiError } from '@genfire/sdk';
import { publicApiRequest } from './client.js';
import { CliError, formatError } from './errors.js';

// A generation the model refuses after its run was created comes back as a
// problem+json 422 carrying `run_id`. The CLI printed only "API error 422 …",
// so the run the user could look up was never named.

test('an API error with a run_id prints "Run <id> failed: <detail>" and the runs get hint', () => {
  const err = new GenFireApiError(
    { type: 'about:blank', title: 'Input Rejected', status: 422, code: 'input_rejected', detail: 'The reference video was refused.', request_id: 'req_1', run_id: 'run_abc' },
    422
  );
  assert.deepEqual(formatError(err), {
    lines: ['Run run_abc failed: The reference video was refused. (input_rejected)', 'Details: genfire runs get run_abc'],
    exitCode: 1
  });
});

test('without a run_id the API error line is unchanged, and the scope hint still follows', () => {
  const err = new GenFireApiError({ status: 403, code: 'insufficient_scope', detail: 'Missing scope videos:write.' }, 403);
  const { lines } = formatError(err);
  assert.equal(lines[0], 'API error 403 (insufficient_scope): Missing scope videos:write.');
  assert.match(lines[1], /genfire auth login/);
  assert.deepEqual(formatError(new CliError('nope', 'bad_flag', 2)), { lines: ['Error (bad_flag): nope'], exitCode: 2 });
});

test('publicApiRequest carries the problem+json run_id onto its CliError', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ status: 422, code: 'input_rejected', detail: 'The clip was refused.', run_id: 'run_xyz' }),
    { status: 422, headers: { 'Content-Type': 'application/problem+json' } }
  )) as unknown as typeof fetch;
  try {
    await assert.rejects(publicApiRequest('POST', '/videos/generations', { body: {} }), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.runId, 'run_xyz');
      assert.deepEqual(formatError(err).lines, ['Run run_xyz failed: The clip was refused. (input_rejected)', 'Details: genfire runs get run_xyz']);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GENFIRE_API_KEY;
    else process.env.GENFIRE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GENFIRE_API_BASE_URL;
    else process.env.GENFIRE_API_BASE_URL = originalBase;
  }
});
