import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerTimelineCommands } from './timeline.js';

// Timelines go straight through publicApiRequest, so these drive the real
// commander wiring against a stubbed fetch and pin the body the API reads.

interface Captured { url: string; method: string; body: any }

const TIMELINE = {
  id: 'tl_1', object: 'timeline', rev: 2, manifest_hash: 'abcdef0123456789abcdef', title: null, project_id: null,
  manifest: { version: 1, duration: 6, width: 1440, height: 1080, fps: 30, clips: [], sources: [], finish: { preset: 'dvd_35mm', intensity: 1, grain: 0.5 } },
  created_at: '', updated_at: ''
};

const MANIFEST_PATH = join(tmpdir(), `genfire-cli-timeline-${process.pid}.json`);
const MANIFEST = {
  width: 1440, height: 1080, duration: 6,
  sources: [{ id: 'sc1', ref: 'https://cdn.example.test/a.mp4' }],
  clips: [{
    id: 'c1', type: 'video', sourceId: 'sc1', startTime: 0, duration: 6, speed: 1.5,
    motion: { keyframes: [{ t: 5.4, scale: 1 }, { t: 6, scale: 1.8, ease: 'power2.in' }], motionBlur: 0.6 }
  }]
};

async function runCli(argv: string[]): Promise<Captured[]> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  const originalWrite = process.stdout.write;
  const calls: Captured[] = [];
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(TIMELINE), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const program = new Command().exitOverride();
    registerTimelineCommands(program);
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    process.stdout.write = originalWrite;
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GENFIRE_API_KEY;
    else process.env.GENFIRE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GENFIRE_API_BASE_URL;
    else process.env.GENFIRE_API_BASE_URL = originalBase;
  }
  return calls;
}

test('create sends speed and motion verbatim and --finish as the finish block', async () => {
  await writeFile(MANIFEST_PATH, JSON.stringify(MANIFEST));
  const calls = await runCli(['timeline', 'create', '-f', MANIFEST_PATH, '--finish', 'dvd_35mm', '--finish-grain', '0.3']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body.clips, MANIFEST.clips);
  assert.deepEqual(calls[0].body.finish, { preset: 'dvd_35mm', grain: 0.3 });
});

test('update carries --finish on the replace', async () => {
  await writeFile(MANIFEST_PATH, JSON.stringify(MANIFEST));
  const calls = await runCli(['timeline', 'update', 'tl_1', '-f', MANIFEST_PATH, '-r', '2', '--finish', 'camcorder']);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].body.rev, 2);
  assert.deepEqual(calls[0].body.finish, { preset: 'camcorder' });
});

test('an unknown preset or a stray intensity fails before any request', async () => {
  await writeFile(MANIFEST_PATH, JSON.stringify(MANIFEST));
  await assert.rejects(runCli(['timeline', 'create', '-f', MANIFEST_PATH, '--finish', 'vhs']), /--finish must be one of/);
  await assert.rejects(runCli(['timeline', 'create', '-f', MANIFEST_PATH, '--finish-intensity', '0.5']), /need --finish/);
  await assert.rejects(runCli(['timeline', 'create', '-f', MANIFEST_PATH, '--finish', 'none', '--finish-grain', '2']), /0 to 1/);
});
