import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { lastFrameTargetPath, lastFrameUrlOf } from './runHelpers.js';
import { registerGenerateCommands } from './commands/generate.js';
import { registerRunsCommand } from './commands/runs.js';

// `output.last_frame_url` on a completed video run: a still of the final frame
// for chaining the next shot. `generate video` downloads only the video unless
// --save-last-frame is passed (then the still lands beside it); otherwise the
// URL is printed. `runs get` shows it.

const VIDEO = 'https://firebasestorage.googleapis.com/v0/b/b/o/generated-videos%2Fv1%2Fv1.mp4?alt=media&token=a';
const FRAME = 'https://firebasestorage.googleapis.com/v0/b/b/o/generated-videos%2Fv1%2Fv1_last.jpg?alt=media&token=c';

test('lastFrameUrlOf reads output.last_frame_url, http(s) only', () => {
  assert.equal(lastFrameUrlOf({ output: { video_url: VIDEO, last_frame_url: FRAME } }), FRAME);
  assert.equal(lastFrameUrlOf({ output: { video_url: VIDEO } }), null);
  assert.equal(lastFrameUrlOf({ output: { last_frame_url: 'javascript:alert(1)' } }), null);
  assert.equal(lastFrameUrlOf({ output: null }), null);
  assert.equal(lastFrameUrlOf(null), null);
});

test('lastFrameTargetPath: beside a single saved video, else <base>-last-frame in the -o dir / cwd', () => {
  assert.equal(lastFrameTargetPath(FRAME, ['/out/shot.mp4'], '/out/shot.mp4'), join('/out', 'shot.last-frame.jpg'));
  assert.equal(lastFrameTargetPath(FRAME, ['/a.mp4', '/b.mp4'], '/dir', 'video'), join('/dir', 'video-last-frame.jpg'));
  assert.equal(lastFrameTargetPath('https://x.test/f.png', [], undefined, 'video'), join(process.cwd(), 'video-last-frame.png'));
  assert.equal(lastFrameTargetPath('https://x.test/no-ext', ['/o/v.mp4'], undefined), join('/o', 'v.last-frame.jpg'));
});

async function runCli(argv: string[], output: Record<string, unknown>): Promise<{ gets: string[]; stdout: string; stderr: string }> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const gets: string[] = [];
  let stdout = '';
  let stderr = '';
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  const done = {
    id: 'run_1', object: 'run', status: 'completed', capability: 'video_generation', endpoint: 'videos.generations.create',
    model: 'video.seedance_2_5', request_id: 'run_1', input_summary: null, output, usage: null, error: null, resource_id: 'v1',
    provider_request_id: null, created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:01:00Z', completed_at: '2026-10-12T00:01:00Z'
  };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    if (u === VIDEO) { gets.push('video'); return new Response('VIDEO-BYTES', { status: 200 }); }
    if (u === FRAME) { gets.push('frame'); return new Response('FRAME-BYTES', { status: 200 }); }
    const path = new URL(u).pathname.replace(/^\/v1/, '');
    const payload = path.endsWith('/generations') && init.method === 'POST'
      ? { ...done, status: 'queued', output: null }
      : done;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  // Tee, never swallow: the test reporter owns stdout (see commands/media.test.ts).
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => { stdout += String(chunk); return originalStdout(chunk, ...rest); };
  (process.stderr as any).write = (chunk: any) => { stderr += String(chunk); return true; };
  try {
    const program = new Command().exitOverride();
    registerGenerateCommands(program);
    registerRunsCommand(program);
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    globalThis.fetch = originalFetch;
    (process.stdout as any).write = originalStdout;
    (process.stderr as any).write = originalStderr;
    if (originalKey === undefined) delete process.env.GENFIRE_API_KEY; else process.env.GENFIRE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GENFIRE_API_BASE_URL; else process.env.GENFIRE_API_BASE_URL = originalBase;
  }
  return { gets, stdout, stderr };
}

test('generate video downloads ONLY the video by default and prints the last-frame URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genfire-lastframe-'));
  try {
    const target = join(dir, 'shot.mp4');
    const r = await runCli(['generate', 'video', 'a fox runs', '-m', 'video.seedance_2_5', '-o', target, '--wait-interval', '1ms'], { video_url: VIDEO, thumbnail_url: null, video_id: 'v1', last_frame_url: FRAME });
    assert.deepEqual(r.gets, ['video']);
    assert.equal(readFileSync(target, 'utf8'), 'VIDEO-BYTES');
    assert.equal(existsSync(join(dir, 'shot.last-frame.jpg')), false);
    assert.match(r.stderr, new RegExp(`Last frame:.*${FRAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--save-last-frame also saves the still beside the video', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genfire-lastframe-'));
  try {
    const target = join(dir, 'shot.mp4');
    const r = await runCli(['generate', 'video', 'a fox runs', '-m', 'video.seedance_2_5', '-o', target, '--save-last-frame', '--wait-interval', '1ms'], { video_url: VIDEO, last_frame_url: FRAME });
    assert.deepEqual(r.gets, ['video', 'frame']);
    assert.equal(readFileSync(join(dir, 'shot.last-frame.jpg'), 'utf8'), 'FRAME-BYTES');
    assert.doesNotMatch(r.stderr, /Last frame:/, 'saved, so listed under Saved: instead');
    assert.match(r.stderr, /Saved:.*shot\.last-frame\.jpg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--save-last-frame on a video without a still: just the video, no error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genfire-lastframe-'));
  try {
    const r = await runCli(['generate', 'video', 'a fox runs', '-o', join(dir, 'v.mp4'), '--save-last-frame', '--wait-interval', '1ms'], { video_url: VIDEO });
    assert.deepEqual(r.gets, ['video']);
    assert.doesNotMatch(r.stderr, /Last frame:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runs get shows the last frame in its human output', async () => {
  const r = await runCli(['runs', 'get', 'run_1'], { video_url: VIDEO, last_frame_url: FRAME });
  assert.match(r.stdout, /Last frame:/);
  assert.ok(r.stdout.includes(FRAME));
  const none = await runCli(['runs', 'get', 'run_1'], { video_url: VIDEO });
  assert.doesNotMatch(none.stdout, /Last frame:/);
});
