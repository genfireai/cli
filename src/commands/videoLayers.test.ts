import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import {
  editBodyFromFlags,
  liveOpChangesFromFlags,
  parseNumbers,
  parsePair,
  parseTrim,
  registerVideoLayersCommand,
} from './videoLayers.js';

// Video Layers goes straight through publicApiRequest, so these drive the real
// commander wiring against a stubbed fetch and pin method, path, headers and body.

interface Captured { url: string; method: string; body: any; headers: Record<string, string> }

async function runCli(argv: string[], reply: (c: Captured) => unknown): Promise<{ calls: Captured[]; out: string }> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const calls: Captured[] = [];
  let out = '';
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const c: Captured = {
      url: String(url),
      method: String(init.method),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(c);
    return new Response(JSON.stringify(reply(c)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  // The test runner reports to the parent over this same stdout (as Buffers):
  // capture only the CLI's own string output and pass everything else through.
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    if (typeof chunk === 'string') { out += chunk; return true; }
    return originalWrite(chunk, ...rest);
  };
  try {
    const program = new Command().exitOverride();
    registerVideoLayersCommand(program, { pollMs: 1 });
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    (process.stdout as any).write = originalWrite;
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GENFIRE_API_KEY;
    else process.env.GENFIRE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GENFIRE_API_BASE_URL;
    else process.env.GENFIRE_API_BASE_URL = originalBase;
  }
  return { calls, out };
}

const BASE = 'https://api.example.test/v1';
const job = { id: 'vlj_1', type: 'edit', kind: 'replace', status: 'queued', stage: null, progress: 0, quote_credits: 84, charged_credits: null, error: null, result_version_id: null, render: null };

test('video-layers is hidden, aliased vl, and has the full verb set', () => {
  const program = new Command();
  registerVideoLayersCommand(program);
  const cmd = program.commands.find((c) => c.name() === 'video-layers')!;
  assert.ok(cmd);
  assert.equal((cmd as any)._hidden, true);
  assert.deepEqual(cmd.aliases(), ['vl']);
  assert.deepEqual(cmd.commands.map((c) => c.name()), [
    'flags', 'list', 'create', 'get', 'version', 'mattes', 'live-ops', 'edit', 'segment', 'track', 'render', 'job', 'cancel', 'undo', 'rename', 'delete',
  ]);
});

test('create without --yes prices only; nothing starts', async () => {
  const { calls, out } = await runCli(['vl', 'create', 'https://x.test/a.mp4', '--trim', '2:14', '--prompt', 'dog'], () => ({ credits: 60, seconds: 12, notes: [] }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${BASE}/video-layers/quote/split`);
  assert.deepEqual(calls[0].body, { source_url: 'https://x.test/a.mp4', trim: { start_sec: 2, end_sec: 14 }, prompts: ['dog'] });
  assert.match(out, /60 credits/);
  assert.match(out, /Nothing started/);
});

test('create --yes quotes, then starts at that price with an Idempotency-Key', async () => {
  const { calls } = await runCli(['video-layers', 'create', 'https://x.test/a.mp4', '--yes', '--key', 'k1'], (c) => (
    c.url.endsWith('/quote/split') ? { credits: 60, seconds: 12, notes: [] } : { project: { id: 'vlp_1', title: 't' }, job: { ...job, type: 'split', kind: null } }
  ));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/video-layers/quote/split`, `POST ${BASE}/video-layers`]);
  assert.equal(calls[1].body.quote_credits, 60);
  assert.equal(calls[1].headers['Idempotency-Key'], 'k1');
});

test('create --max-credits starts directly (the API prices it against the cap)', async () => {
  const { calls } = await runCli(['vl', 'create', 'https://x.test/a.mp4', '--max-credits', '100'], () => ({ project: { id: 'vlp_1' }, job: { ...job, type: 'split' } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/video-layers`);
  assert.equal(calls[0].body.max_credits, 100);
  assert.ok(calls[0].headers['Idempotency-Key']);
});

test('edit maps flags to the edit body; --quote-credits starts it; --wait polls the job', async () => {
  let polls = 0;
  const { calls, out } = await runCli(
    ['vl', 'edit', 'vlp_1', 'replace', '-l', 'silver sedan', '-p', 'a red convertible', '--quote-credits', '84', '--version-id', 'vlv_1', '--wait'],
    (c) => {
      if (c.method === 'GET') { polls += 1; return { ...job, status: polls >= 2 ? 'succeeded' : 'running', result_version_id: polls >= 2 ? 'vlv_2' : null }; }
      return { job };
    },
  );
  assert.equal(calls[0].url, `${BASE}/video-layers/vlp_1/edits`);
  assert.deepEqual(calls[0].body, { kind: 'replace', layer: 'silver sedan', prompt: 'a red convertible', version_id: 'vlv_1', quote_credits: 84 });
  assert.equal(calls.at(-1)!.url, `${BASE}/video-layers/vlp_1/jobs/vlj_1?view=summary`);
  assert.match(out, /vlv_2/);
});

test('render: a free mp4 starts without --yes', async () => {
  const { calls } = await runCli(['vl', 'render', 'vlp_1'], (c) => (c.url.endsWith('/quote/render') ? { credits: 0, seconds: 12, notes: [] } : { job: { ...job, type: 'render' } }));
  assert.deepEqual(calls.map((c) => c.url), [`${BASE}/video-layers/vlp_1/quote/render`, `${BASE}/video-layers/vlp_1/render`]);
  assert.equal(calls[1].body.quote_credits, 0);
});

test('live-ops sends declarative changes via PATCH', async () => {
  const { calls, out } = await runCli(
    ['vl', 'live-ops', 'vlp_1', '--recolor', 'red car=#2255ff', '--blur', '8', '--keep-sharp', 'woman', '--text', 'shop sign=OPEN', '--exposure', '0.2'],
    () => ({ version: { id: 'vlv_1', preview_url: null }, notes: ['change 1: skipped'] }),
  );
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, `${BASE}/video-layers/vlp_1/live-ops?view=summary`);
  assert.deepEqual(calls[0].body.changes, [
    { op: 'recolor', layer: 'red car', hex: '#2255ff' },
    { op: 'grade', exposure: 0.2 },
    { op: 'blur_background', amount: 8, keep_sharp: ['woman'] },
    { op: 'text', plane: 'shop sign', text: 'OPEN' },
  ]);
  assert.match(out, /note/);
});

test('track builds the quad; segment sends its fields; both carry Idempotency-Keys', async () => {
  const t = await runCli(['vl', 'track', 'vlp_1', '--quad', '0.1,0.2,0.5,0.2,0.5,0.6,0.1,0.6', '--label', 'sign', '--plate'], () => ({ job: { ...job, type: 'track' } }));
  assert.deepEqual(t.calls[0].body, { quad: [[0.1, 0.2], [0.5, 0.2], [0.5, 0.6], [0.1, 0.6]], label: 'sign', make_plate: true });
  assert.ok(t.calls[0].headers['Idempotency-Key']);
  const s = await runCli(['vl', 'segment', 'vlp_1', '-p', 'umbrella', '--frame', '40', '--point', '0.4,0.5'], () => ({ job: { ...job, type: 'segment' } }));
  assert.equal(s.calls[0].url, `${BASE}/video-layers/vlp_1/segment`);
  assert.deepEqual(s.calls[0].body, { prompt: 'umbrella', frame_index: 40, point: [0.4, 0.5] });
});

test('get / job / cancel / undo / rename hit the summary views', async () => {
  const summary = { object: 'video_layers_summary', project: { id: 'vlp_1', title: 't', status: 'ready', error: null, duration_sec: 12, size: '1920x1080', current_version_id: 'v', version_count: 1, updated_at: '' }, version: null, active_jobs: [] };
  assert.equal((await runCli(['vl', 'get', 'vlp_1'], () => summary)).calls[0].url, `${BASE}/video-layers/vlp_1?view=summary`);
  assert.equal((await runCli(['vl', 'get', 'vlp_1', '--full'], () => ({}))).calls[0].url, `${BASE}/video-layers/vlp_1`);
  assert.equal((await runCli(['vl', 'job', 'vlp_1', 'vlj_1'], () => job)).calls[0].url, `${BASE}/video-layers/vlp_1/jobs/vlj_1?view=summary`);
  const cancel = await runCli(['vl', 'cancel', 'vlp_1', 'vlj_1'], () => ({ ...job, status: 'canceled' }));
  assert.equal(`${cancel.calls[0].method} ${cancel.calls[0].url}`, `POST ${BASE}/video-layers/vlp_1/jobs/vlj_1/cancel?view=summary`);
  const undo = await runCli(['vl', 'undo', 'vlp_1'], () => summary);
  assert.equal(`${undo.calls[0].method} ${undo.calls[0].url}`, `POST ${BASE}/video-layers/vlp_1/undo?view=summary`);
  const rename = await runCli(['vl', 'rename', 'vlp_1', 'New title'], () => ({ id: 'vlp_1', title: 'New title' }));
  assert.equal(rename.calls[0].method, 'PATCH');
  assert.deepEqual(rename.calls[0].body, { title: 'New title' });
});

test('delete requires --yes', async () => {
  await assert.rejects(runCli(['vl', 'delete', 'vlp_1'], () => ({})), /--yes/);
  const ok = await runCli(['vl', 'delete', 'vlp_1', '--yes'], () => ({ ok: true, id: 'vlp_1' }));
  assert.equal(`${ok.calls[0].method} ${ok.calls[0].url}`, `DELETE ${BASE}/video-layers/vlp_1`);
});

test('parsers', () => {
  assert.deepEqual(parseNumbers('0.1, 0.2', 2, '--point'), [0.1, 0.2]);
  assert.throws(() => parseNumbers('1,2,3', 2, '--point'), /2 comma-separated/);
  assert.deepEqual(parseTrim('2:14'), { start_sec: 2, end_sec: 14 });
  assert.deepEqual(parseTrim(':9'), { end_sec: 9 });
  assert.deepEqual(parsePair('woman in red=#fff', '--recolor'), ['woman in red', '#fff']);
  assert.throws(() => parsePair('nope', '--recolor'));
  assert.deepEqual(liveOpChangesFromFlags({ recolor: ['car=200'], clear: ['all'], feather: ['car=3'] }), [
    { op: 'recolor', layer: 'car', hue: 200 },
    { op: 'feather', layer: 'car', px: 3 },
    { op: 'clear', what: 'all' },
  ]);
  assert.deepEqual(editBodyFromFlags('remove', { layer: ['a', 'b'] }), { kind: 'remove', layers: ['a', 'b'] });
  assert.deepEqual(editBodyFromFlags('relight', { azimuth: '30', color: '#ffcc88' }), { kind: 'relight', color: '#ffcc88', azimuth: 30 });
  assert.throws(() => editBodyFromFlags('explode', {}), /kind must be one of/);
});
