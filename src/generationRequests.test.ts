import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import {
  buildImageRequest,
  buildSpeechExtras,
  buildVideoRequest,
  parseLoraSpecs,
  parseMultiPrompt,
  validateVideoFlags
} from './generationRequests.js';
import { registerGenerateCommands } from './commands/generate.js';
import { registerCostCommand } from './commands/cost.js';

// A quote from `genfire cost` is only spendable on `genfire generate` when both
// bodies carry the same price inputs spelled the same way — the API hashes the
// RAW body on both sides (PublicApiQuoteService.quoteInputsFor). These tests
// drive the real commander wiring for both commands against a stubbed fetch
// and require the two bodies to be identical apart from `prompt`.

interface Captured { url: string; method: string; body: any }

const passthrough = async (input: string) => (input.startsWith('http') ? input : `https://cdn.example/${input}`);

async function runCli(argv: string[]): Promise<Captured[]> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  const calls: Captured[] = [];
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  const run = { id: 'run_1', object: 'run', status: 'queued', capability: 'video_generation', endpoint: 'x', created_at: '2026-01-01T00:00:00Z' };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = String(init.method || 'GET');
    calls.push({ url: String(url), method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const path = new URL(String(url)).pathname.replace(/^\/v1/, '');
    let payload: unknown = { object: 'list', data: [] };
    if (path === '/models/estimate-cost') {
      payload = { object: 'cost_estimate', model: 'm', capability: 'c', credits: 1, unit: 'total', breakdown: {} };
    } else if (path === '/account/credits') {
      payload = { account_id: 'a', balance: 10, currency: 'credits' };
    } else if (path.startsWith('/runs/') || path.endsWith('/generations')) {
      payload = run;
    } else if (path === '/models') {
      payload = { object: 'list', data: [
        { id: 'image.default_one', capability: 'image_generation', is_default: true },
        { id: 'video.default_one', capability: 'video_generation', is_default: true }
      ] };
    } else if (path === '/elements') {
      payload = { object: 'list', data: [{ id: 'el_1', handle: 'bottle', name: 'Bottle' }] };
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    const program = new Command().exitOverride();
    registerGenerateCommands(program);
    registerCostCommand(program);
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

function bodyOf(calls: Captured[], suffix: string): any {
  const hit = calls.find((c) => c.method === 'POST' && c.url.endsWith(suffix));
  assert.ok(hit, `expected a POST to ${suffix}; saw ${calls.map((c) => `${c.method} ${c.url}`).join(', ')}`);
  return hit!.body;
}

test('generate video and cost video send the same body for the same flags (quote stays spendable)', async () => {
  const flags = [
    '-m', 'video.seedance_2_5', '-d', '8', '-r', '1080p',
    '--ref-image', 'https://cdn.example/a.png',
    '--ref-video', 'https://cdn.example/clip.mp4',
    '--ref-video-trim', '0:1-6',
    '--task', 'editing', '--bitrate', 'high', '--no-audio'
  ];
  const gen = bodyOf(await runCli(['generate', 'video', 'relight @Video1', ...flags, '--no-wait']), '/videos/generations');
  const est = bodyOf(await runCli(['cost', 'video', 'relight @Video1', ...flags]), '/models/estimate-cost');
  const { prompt, ...genRest } = gen;
  assert.equal(prompt, 'relight @Video1');
  assert.deepEqual(genRest, est);
  assert.equal(est.generate_audio, false);
  assert.deepEqual(est.reference_video_trims, [{ index: 0, start: 1, end: 6 }]);
  assert.equal(est.task, 'editing');
});

test('video: audio is NOT sent unless --no-audio (a default `true` broke every default quote)', async () => {
  const est = bodyOf(await runCli(['cost', 'video', 'x', '-m', 'video.veo_3_1']), '/models/estimate-cost');
  assert.equal('generate_audio' in est, false);
  const gen = bodyOf(await runCli(['generate', 'video', 'x', '-m', 'video.veo_3_1', '--no-wait']), '/videos/generations');
  assert.equal('generate_audio' in gen, false);
});

test('generate image and cost image agree, and count is always sent (default 1)', async () => {
  const flags = ['-m', 'image.gpt_image_2', '-q', 'high', '-r', '2K', '-i', 'https://cdn.example/src.png', '--mask', 'https://cdn.example/m.png'];
  const gen = bodyOf(await runCli(['generate', 'image', 'swap the sky', ...flags, '--no-wait']), '/images/generations');
  const est = bodyOf(await runCli(['cost', 'image', 'swap the sky', ...flags]), '/models/estimate-cost');
  const { prompt, ...genRest } = gen;
  assert.equal(prompt, 'swap the sky');
  assert.deepEqual(genRest, est);
  assert.equal(est.count, 1);
  assert.equal(est.mask_url, 'https://cdn.example/m.png');
});

test('an @element handle in an image prompt no longer dies as an unknown influencer', async () => {
  const calls = await runCli(['generate', 'image', '@bottle on marble', '-m', 'image.nano_banana_2', '--no-wait']);
  const gen = bodyOf(calls, '/images/generations');
  assert.equal(gen.prompt, '@bottle on marble');
  assert.equal(gen.mentions, undefined);
});

test('cost video without -m prices the API default model', async () => {
  const calls = await runCli(['cost', 'video', 'a fox']);
  assert.equal(bodyOf(calls, '/models/estimate-cost').model, 'video.default_one');
});

test('buildVideoRequest maps every structured input onto its wire field', async () => {
  const body = await buildVideoRequest({
    model: 'video.kling_o3',
    startImage: 'start.png',
    endImage: 'end.png',
    multiPrompt: ['5:she opens the door', 'he waves'],
    shotType: 'Customize',
    lora: ['lora_a:0.8', 'lora_b'],
    keyframe: ['0:k0.png', '96:k1.png'],
    firstFrame: 'f.png',
    lastFrame: 'l.png',
    sourceVideo: 'src.mp4',
    webUrl: 'https://example.com/page',
    cameraPath: 'orbit',
    brand: 'brand_1',
    template: 'tpl_1',
    productImage: 'prod.png',
    audio: true
  }, passthrough);
  assert.deepEqual(body, {
    model: 'video.kling_o3',
    start_image_url: 'https://cdn.example/start.png',
    end_image_url: 'https://cdn.example/end.png',
    first_frame_url: 'https://cdn.example/f.png',
    last_frame_url: 'https://cdn.example/l.png',
    source_video_url: 'https://cdn.example/src.mp4',
    keyframes: [
      { frame_index: 0, image_url: 'https://cdn.example/k0.png' },
      { frame_index: 96, image_url: 'https://cdn.example/k1.png' }
    ],
    web_url: 'https://example.com/page',
    loras: [{ id: 'lora_a', scale: 0.8 }, { id: 'lora_b' }],
    multi_prompt: [{ prompt: 'she opens the door', duration: '5' }, { prompt: 'he waves' }],
    shot_type: 'customize',
    camera_path: 'orbit',
    brand_id: 'brand_1',
    marketing_template_id: 'tpl_1',
    product_image_url: 'https://cdn.example/prod.png'
  });
});

test('video validation fails before anything uploads', () => {
  assert.throws(() => validateVideoFlags({ endImage: 'e.png' }), /Pair it with --image/);
  assert.doesNotThrow(() => validateVideoFlags({ endImage: 'e.png', startImage: 's.png' }));
  assert.throws(() => validateVideoFlags({ firstFrame: 'f.png' }), /together/);
  assert.throws(() => validateVideoFlags({ task: 'editing' }), /--ref-video/);
  assert.throws(() => validateVideoFlags({ cameraPath: 'barrel_roll' }), /--camera-path must be one of/);
  assert.throws(() => validateVideoFlags({ damageLevel: 'heavy', style: 'low_poly' }), /--style vhs/);
  assert.throws(() => validateVideoFlags({ refVideo: ['a.mp4'], refVideoTrim: ['1:0-3'] }), /no --ref-video #1/);
  assert.throws(() => validateVideoFlags({ keyframe: ['start.png'] }), /FRAME:urlOrPath/);
});

test('image builder: styles, Z-Image tuning and grounding', async () => {
  const body = await buildImageRequest({
    model: 'image.z_image_turbo',
    count: '2',
    imageStyle: ['sty_1:1.2'],
    strength: '0.4',
    moodboard: 'mb_1',
    moodboardStrength: 'Strong',
    avatar: 'influencer:abc',
    image: ['a.png']
  }, passthrough);
  assert.deepEqual(body, {
    model: 'image.z_image_turbo',
    count: 2,
    image_url: 'https://cdn.example/a.png',
    moodboard_id: 'mb_1',
    moodboard_strength: 'strong',
    loras: [{ id: 'sty_1', scale: 1.2 }],
    strength: 0.4,
    avatar_id: 'influencer:abc'
  });
  await assert.rejects(buildImageRequest({ mask: 'm.png' }, passthrough), /pass the source with -i/);
  await assert.rejects(buildImageRequest({ count: '5' }, passthrough), /between 1 and 4/);
});

test('parsers', () => {
  assert.deepEqual(parseLoraSpecs(['a', 'b:0.5'], '--lora', 3), [{ id: 'a' }, { id: 'b', scale: 0.5 }]);
  assert.throws(() => parseLoraSpecs(['a', 'b', 'c', 'd'], '--lora', 3), /at most 3/);
  assert.deepEqual(parseMultiPrompt(['12: wide shot']), [{ prompt: 'wide shot', duration: '12' }]);
  assert.throws(() => parseMultiPrompt(['20:too long']), /1-15/);
});

test('speech extras: influencer mention by id or @handle; text XOR dialogue', async () => {
  assert.deepEqual(await buildSpeechExtras('hi', { influencer: '@maya' }), { mention: { handle: 'maya' } });
  assert.deepEqual(await buildSpeechExtras('hi', { influencer: 'inf_1', stability: '0.3' }), { mention: { influencer_id: 'inf_1' }, stability: 0.3 });
  await assert.rejects(buildSpeechExtras(undefined, {}), /--dialogue-file/);
});
