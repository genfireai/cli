import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { registerBladeCommand } from './blade.js';

// Blade goes straight through publicApiRequest (the pinned SDK has no Blade
// methods), so these drive the real commander wiring against a stubbed fetch
// and pin method, path, headers and body.

interface Captured { url: string; method: string; body: unknown; headers: Record<string, string> }

async function runCli(argv: string[], response: unknown): Promise<Captured[]> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  const calls: Captured[] = [];
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init.method),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    const program = new Command().exitOverride();
    registerBladeCommand(program);
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GENFIRE_API_KEY;
    else process.env.GENFIRE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GENFIRE_API_BASE_URL;
    else process.env.GENFIRE_API_BASE_URL = originalBase;
  }
  return calls;
}

const session = { object: 'blade_session', id: 'bld_1', project_id: 'p1', preset: null, status: 'started', quoted_credits: null, cap_credits: null, run_ids: [], spent_credits: 0, final: null };

test('blade is hidden from help but callable', () => {
  const program = new Command();
  registerBladeCommand(program);
  const cmd = program.commands.find((c) => c.name() === 'blade')!;
  assert.ok(cmd);
  assert.equal((cmd as any)._hidden, true);
  assert.deepEqual(cmd.commands.map((c) => c.name()), ['presets', 'start', 'status', 'quote', 'finish']);
});

test('presets lists, or reads one by slug', async () => {
  const list = await runCli(['blade', 'presets'], { object: 'list', data: [] });
  assert.equal(list[0].url, 'https://api.example.test/v1/blade/presets');
  const one = await runCli(['blade', 'presets', 'beat cut'], { slug: 'beat-cut', title: 'Beat cut', category: 'personal_edit', description: '', reference: { media_url: 'https://x' }, inputs: { images: { min: 1, max: 10 }, clips: null } });
  assert.equal(one[0].url, 'https://api.example.test/v1/blade/presets/beat%20cut');
});

test('start posts the Contract 2 body with an Idempotency-Key', async () => {
  const calls = await runCli(
    ['blade', 'start', '--preset', 'beat-cut', '-i', 'run_1', '--input', 'https://x/a.jpg,https://x/b.jpg', '--note', 'summer', '--project', 'p1', '--key', 'k1'],
    { session_id: 'bld_1', project_id: 'p1', project_created: false, next: ['one'], notes: [] },
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.example.test/v1/blade/sessions');
  assert.equal(calls[0].headers['Idempotency-Key'], 'k1');
  assert.deepEqual(calls[0].body, { preset: 'beat-cut', input_media_ids: ['run_1', 'https://x/a.jpg', 'https://x/b.jpg'], note: 'summer', project_id: 'p1' });
});

test('status, quote and finish hit the session routes', async () => {
  const status = await runCli(['blade', 'status', 'bld_1'], session);
  assert.equal(status[0].url, 'https://api.example.test/v1/blade/sessions/bld_1');
  const quote = await runCli(['blade', 'quote', 'bld_1', '--quoted', '640', '--cap', '800'], session);
  assert.equal(quote[0].url, 'https://api.example.test/v1/blade/sessions/bld_1/quote');
  assert.deepEqual(quote[0].body, { quoted_credits: 640, cap_credits: 800 });
  const finish = await runCli(['blade', 'finish', 'bld_1', '--video', 'sandbox_c_0', '--timeline', 'tl_1', '-r', 'run_1,run_2', '-r', 'run_3'], { ...session, status: 'delivered', delivery: { filed: true, credits: { pending_run_ids: [], over_cap: false } } });
  assert.equal(finish[0].url, 'https://api.example.test/v1/blade/sessions/bld_1/complete');
  assert.deepEqual(finish[0].body, { video_generation_id: 'sandbox_c_0', timeline_id: 'tl_1', run_ids: ['run_1', 'run_2', 'run_3'] });
});

test('status with no id lists your sessions, newest first, with paging', async () => {
  const row = { session_id: 'bld_1', status: 'delivered', preset: 'beat-cut', project_id: 'p1', created_at: '2026-10-27T10:00:00.000Z', updated_at: '2026-10-27T10:30:00.000Z', spent_credits: 600, final: null };
  const first = await runCli(['blade', 'status'], { object: 'list', data: [row], next_cursor: 'c1' });
  assert.equal(first[0].method, 'GET');
  assert.equal(first[0].url, 'https://api.example.test/v1/blade/sessions');
  const paged = await runCli(['blade', 'status', '--limit', '5', '--cursor', 'c1'], { object: 'list', data: [], next_cursor: null });
  assert.equal(paged[0].url, 'https://api.example.test/v1/blade/sessions?limit=5&cursor=c1');
});

test('finish --timeline-file sends the manifest itself as `timeline`', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'blade-cli-'));
  const file = join(dir, 'timeline.json');
  const manifest = { fps: 30, width: 1080, height: 1920, clips: [{ source: 'run_1', in: 0, out: 2 }] };
  writeFileSync(file, JSON.stringify(manifest));
  const finish = await runCli(['blade', 'finish', 'bld_1', '--run', 'run_9', '--timeline-file', file], { ...session, status: 'delivered', delivery: { filed: true, credits: { pending_run_ids: [], over_cap: false } } });
  assert.deepEqual(finish[0].body, { run_id: 'run_9', timeline: manifest });
});
