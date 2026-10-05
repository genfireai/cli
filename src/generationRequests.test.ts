import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import {
  buildImageRequest,
  buildSpeechExtras,
  buildVideoRequest,
  draftFinalPath,
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

interface Captured { url: string; method: string; body: any; headers?: Record<string, string> }

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
    calls.push({ url: String(url), method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), headers: (init.headers ?? {}) as Record<string, string> });
    const path = new URL(String(url)).pathname.replace(/^\/v1/, '');
    let payload: unknown = { object: 'list', data: [] };
    if (path === '/models/estimate-cost') {
      payload = { object: 'cost_estimate', model: 'm', capability: 'c', credits: 1, unit: 'total', breakdown: {} };
    } else if (path === '/account/credits') {
      payload = { account_id: 'a', balance: 10, currency: 'credits' };
    } else if (path.startsWith('/runs/') || path.endsWith('/generations') || path.endsWith('/final')) {
      payload = run;
    } else if (path.endsWith('/final/estimate')) {
      payload = { object: 'cost_estimate', model: 'video.seedance_2_5', capability: 'video_generation', credits: 470, unit: 'total', breakdown: {}, expires_at: '2026-10-12T12:00:00.000Z' };
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

test('H3 Max Insert: the window + --no-color-match reach both bodies identically, and pick the model', async () => {
  const flags = [
    '--source-video', 'https://cdn.example/src.mp4', '--insert-start', '2.5s', '--insert-resume', '6',
    '--ref-image', 'https://cdn.example/dragon.png', '-d', '8', '-r', '480p', '--no-color-match'
  ];
  const gen = bodyOf(await runCli(['generate', 'video', 'a dragon swoops past', ...flags, '--no-wait']), '/videos/generations');
  const est = bodyOf(await runCli(['cost', 'video', 'a dragon swoops past', ...flags]), '/models/estimate-cost');
  const { prompt, ...genRest } = gen;
  assert.equal(prompt, 'a dragon swoops past');
  assert.deepEqual(genRest, est);
  assert.equal(est.model, 'video.hailuo_03_max_insert');
  assert.equal(est.insert_start_time, 2.5);
  assert.equal(est.insert_resume_time, 6);
  assert.equal(est.color_match, false);

  // color_match is only ever the explicit opt-out; an explicit -m is kept.
  const plain = await buildVideoRequest({ model: 'video.hailuo_03_max_insert', sourceVideo: 'src.mp4', insertStart: '2', insertResume: '4', colorMatch: true }, passthrough);
  assert.equal('color_match' in plain, false);
  assert.equal(plain.model, 'video.hailuo_03_max_insert');
  const other = await buildVideoRequest({ model: 'video.veo_3_1', colorMatch: true }, passthrough);
  for (const key of ['insert_start_time', 'insert_resume_time', 'color_match']) assert.equal(key in other, false);
});

test('H3 Max Insert flag validation fails before anything uploads', () => {
  const src = { sourceVideo: 'src.mp4' };
  assert.throws(() => validateVideoFlags({ ...src, insertStart: '2' }), /pass both/);
  assert.throws(() => validateVideoFlags({ ...src, insertResume: '4' }), /pass both/);
  assert.throws(() => validateVideoFlags({ ...src, insertStart: '1', insertResume: '4' }), /--insert-start must be between/);
  assert.throws(() => validateVideoFlags({ ...src, insertStart: '5', insertResume: '3' }), /must be later than/);
  assert.throws(() => validateVideoFlags({ ...src, insertStart: '2', insertResume: '61' }), /--insert-resume must be between/);
  assert.throws(() => validateVideoFlags({ ...src, insertStart: 'soon', insertResume: '4' }), /must be a number/);
  assert.throws(() => validateVideoFlags({ insertStart: '2', insertResume: '4' }), /--source-video/);
  assert.throws(() => validateVideoFlags({ colorMatch: false }), /--insert-start/);
  assert.doesNotThrow(() => validateVideoFlags({ ...src, insertStart: '2', insertResume: '4', colorMatch: false }));
});

test('H3 Max Recast: clip + cast ride the existing flags, identically on cost and generate, with an empty prompt', async () => {
  const flags = [
    '-m', 'video.hailuo_03_max_recast', '--source-video', 'https://cdn.example/src.mp4',
    '--ref-image', 'https://cdn.example/p1.png', '--ref-image', 'https://cdn.example/p2.png', '-r', '768p'
  ];
  const gen = bodyOf(await runCli(['generate', 'video', '', ...flags, '--no-wait']), '/videos/generations');
  const est = bodyOf(await runCli(['cost', 'video', ...flags]), '/models/estimate-cost');
  const { prompt, ...genRest } = gen;
  assert.equal(prompt, '');
  assert.deepEqual(genRest, est);
  assert.equal(est.model, 'video.hailuo_03_max_recast');
  assert.equal(est.source_video_url, 'https://cdn.example/src.mp4');
  assert.deepEqual(est.reference_image_urls, ['https://cdn.example/p1.png', 'https://cdn.example/p2.png']);
  assert.equal(est.resolution, '768p');
  // No window, no duration default: nothing Insert-shaped rides along.
  for (const key of ['insert_start_time', 'insert_resume_time', 'color_match', 'duration']) assert.equal(key in est, false);
});

test('H3 Max Recast flag validation fails before anything uploads — and only on Recast', () => {
  const recast = { model: 'video.hailuo_03_max_recast', sourceVideo: 'src.mp4', refImage: ['a.png'] };
  assert.doesNotThrow(() => validateVideoFlags(recast));
  assert.doesNotThrow(() => validateVideoFlags({ ...recast, refImage: ['a', 'b', 'c', 'd'], resolution: '1080p' }));
  assert.throws(() => validateVideoFlags({ ...recast, sourceVideo: undefined }), /--source-video/);
  assert.throws(() => validateVideoFlags({ ...recast, refImage: undefined }), /pass 1-4 with --ref-image/);
  assert.throws(() => validateVideoFlags({ ...recast, refImage: ['a', 'b', 'c', 'd', 'e'] }), /up to 4 people .* remove 1/);
  assert.throws(() => validateVideoFlags({ ...recast, refVideo: ['r.mp4'] }), /cast photos only/);
  assert.throws(() => validateVideoFlags({ ...recast, image: 'start.png' }), /as --ref-image, not as a start/);
  assert.throws(() => validateVideoFlags({ ...recast, resolution: '480p' }), /768p or 1080p/);
  // The same flags on any other model are untouched by the Recast rules.
  assert.doesNotThrow(() => validateVideoFlags({ model: 'video.hailuo_03_max', resolution: '480p' }));
  assert.doesNotThrow(() => validateVideoFlags({ model: 'video.hailuo_03_max_3d', sourceVideo: 'src.mp4' }));
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

test('--draft rides generate AND cost identically, and is absent without the flag', async () => {
  const flags = ['-m', 'video.seedance_2_5', '-d', '10', '--draft'];
  const gen = bodyOf(await runCli(['generate', 'video', 'a lighthouse', ...flags, '--no-wait']), '/videos/generations');
  const est = bodyOf(await runCli(['cost', 'video', 'a lighthouse', ...flags]), '/models/estimate-cost');
  const { prompt: _prompt, ...genRest } = gen;
  assert.deepEqual(genRest, est);
  assert.equal(est.draft, true);
  const plain = bodyOf(await runCli(['cost', 'video', 'x', '-m', 'video.seedance_2_5']), '/models/estimate-cost');
  assert.equal('draft' in plain, false);
});

test('draft-final renders and prices the draft by id, keyed, with --project filed', async () => {
  const calls = await runCli(['generate', 'draft-final', 'run_draft1', '--no-wait', '--project', 'proj_1']);
  const final = calls.find((c) => c.method === 'POST' && c.url.endsWith('/videos/generations/run_draft1/final'));
  assert.ok(final, `saw ${calls.map((c) => `${c.method} ${c.url}`).join(', ')}`);
  assert.deepEqual(final!.body, { project_id: 'proj_1' });
  assert.ok(final!.headers?.['Idempotency-Key'], 'the final is a billable submit and must carry an Idempotency-Key');

  const bare = bodyOf(await runCli(['generate', 'draft-final', 'vid_abc', '--no-wait']), '/videos/generations/vid_abc/final');
  assert.deepEqual(bare, {});

  const quoted = await runCli(['cost', 'draft-final', 'run_draft1']);
  assert.ok(quoted.some((c) => c.method === 'POST' && c.url.endsWith('/videos/generations/run_draft1/final/estimate')));
});

test('draftFinalPath refuses anything that is not an id', () => {
  assert.equal(draftFinalPath(' run_x1 '), '/videos/generations/run_x1/final');
  assert.equal(draftFinalPath('vid_9', true), '/videos/generations/vid_9/final/estimate');
  assert.throws(() => draftFinalPath(''), /run id/);
  assert.throws(() => draftFinalPath('../runs'), /run id/);
});
