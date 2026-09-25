import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { registerComposeCommand, buildClip, buildTrack, parseMediaSpec } from './compose.js';
import { registerMediaCommands, parseViewport } from './media.js';

// Drives the real commander wiring against a stubbed fetch, so these pin the
// WIRE shape each command sends — the route, the Idempotency-Key header and
// the body field names the API actually reads (backend routes/publicV1.ts).

interface Captured { url: string; init: RequestInit }

async function runCli(argv: string[], response: unknown = { id: 'run_1', object: 'run', status: 'queued' }): Promise<Captured[]> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  const originalErr = process.stderr.write.bind(process.stderr);
  const captured: Captured[] = [];
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  // Quiet the progress lines. stdout is left alone: the test reporter owns it.
  process.stderr.write = (() => true) as any;
  try {
    const program = new Command().exitOverride();
    registerComposeCommand(program);
    registerMediaCommands(program);
    await program.parseAsync(['node', 'genfire', ...argv]);
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalErr;
    if (originalKey === undefined) delete process.env.GENFIRE_API_KEY; else process.env.GENFIRE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GENFIRE_API_BASE_URL; else process.env.GENFIRE_API_BASE_URL = originalBase;
  }
  return captured;
}

test('compose posts clips, tracks and captions in the route\'s snake_case shape', async () => {
  const calls = await runCli([
    'compose',
    '--clip', 'https://cdn.example.test/a.mp4|trim_in=1|trim_out=0.5|transition=300',
    '--clip', 'https://cdn.example.test/still.png|duration=4|motion=kenburns-in|audio=https://cdn.example.test/line.mp3|audio_mode=mix|mute',
    '--audio', 'https://cdn.example.test/bed.mp3|volume=0.15|loop|fade_out=2',
    '-a', '9:16', '--fit', 'contain', '--clip-audio-volume', '0.3',
    '--captions', 'bold_pop', '--caption-position', 'bottom',
    '--title', 'Test film', '--project', 'proj_1',
    '--no-wait',
  ]);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://api.example.test/v1/videos/compose');
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.ok(headers['Idempotency-Key'], 'compose is behind requireIdempotencyKey');
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    clips: [
      { url: 'https://cdn.example.test/a.mp4', kind: 'video', trim_in_sec: 1, trim_out_sec: 0.5, transition_ms: 300 },
      {
        url: 'https://cdn.example.test/still.png', kind: 'image', duration_sec: 4, motion: 'kenburns-in',
        audio_url: 'https://cdn.example.test/line.mp3', audio_mode: 'mix', mute_audio: true,
      },
    ],
    audio: [{ url: 'https://cdn.example.test/bed.mp3', volume: 0.15, loop: true, fade_out_sec: 2 }],
    aspect_ratio: '9:16',
    fit: 'contain',
    clip_audio_volume: 0.3,
    title: 'Test film',
    project_id: 'proj_1',
    captions: { preset_id: 'bold_pop', position: 'bottom' },
  });
});

test('compose rejects a typo\'d modifier before any request is made', async () => {
  await assert.rejects(
    runCli(['compose', '--clip', 'https://cdn.example.test/a.mp4|trimin=1', '--no-wait']),
    /unknown modifier "trimin"/,
  );
});

test('compose needs at least one clip', async () => {
  await assert.rejects(runCli(['compose', '--no-wait']), /at least one --clip/);
});

test('media inspect posts { url } to /media/inspect with no idempotency key (free, sync)', async () => {
  const calls = await runCli(['media', 'inspect', 'run_abc'], { object: 'media_inspection', source: { kind: 'run' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/media/inspect');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { url: 'run_abc' });
  assert.ok(!('Idempotency-Key' in (calls[0].init.headers as Record<string, string>)));
});

test('media analyze routes a YouTube link to youtube_url and sends depth', async () => {
  const calls = await runCli(['media', 'analyze', 'https://youtu.be/xyz', '--depth', 'shot-list', '--no-wait']);
  assert.equal(calls[0].url, 'https://api.example.test/v1/videos/analyses');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { youtube_url: 'https://youtu.be/xyz', depth: 'shot-list' });
  assert.ok((calls[0].init.headers as Record<string, string>)['Idempotency-Key']);
});

test('media convert-voice sends video_url for a video source', async () => {
  const calls = await runCli(
    ['media', 'convert-voice', '--video', 'https://cdn.example.test/take.mp4', '--voice-id', 'v_1', '--remove-noise', '--no-download'],
    { id: 'run_2', object: 'run', status: 'completed', output: {} },
  );
  assert.equal(calls[0].url, 'https://api.example.test/v1/audio/voice-conversions');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    video_url: 'https://cdn.example.test/take.mp4', voice_id: 'v_1', remove_background_noise: true,
  });
});

test('spec parsing helpers', () => {
  assert.deepEqual(parseMediaSpec('./a.mp4|loop|volume=0.2', '--audio'), { source: './a.mp4', mods: { loop: true, volume: '0.2' } });
  assert.throws(() => buildTrack(parseMediaSpec('x|volume=2', '--audio'), 'https://x', 0), /volume is 0-1/);
  assert.equal(buildClip(parseMediaSpec('https://x/a.JPG', '--clip'), 'https://x/a.JPG', undefined, 0).kind, 'image');
  assert.deepEqual(parseViewport('mobile:390x844'), { name: 'mobile', width: 390, height: 844 });
  assert.throws(() => parseViewport('390by844'), /WIDTHxHEIGHT/);
});
