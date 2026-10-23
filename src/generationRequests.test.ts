import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  buildImageRequest,
  buildSpeechExtras,
  buildVectorizeRequest,
  buildVideoRequest,
  draftFinalPath,
  looksLikePrompt,
  matchClipSeconds,
  parseLoraSpecs,
  parseMultiPrompt,
  recoverTrailingPrompt,
  validateVideoFlags,
  VIDEO_VARIADIC_FLAGS,
  videoEstimateCount
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

/** What the stubbed `POST /media/inspect` measures every clip at (null = unreadable). */
let inspectSeconds: number | null = 7.4;
/** What the inspect mock says about the clip's soundtrack (the API returns a boolean). */
let inspectHasAudio: boolean | undefined = true;

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
    // The storage PUT carries the file's bytes, not JSON.
    if (method === 'PUT') {
      calls.push({ url: String(url), method, body: undefined, headers: (init.headers ?? {}) as Record<string, string> });
      return new Response('', { status: 200 });
    }
    calls.push({ url: String(url), method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), headers: (init.headers ?? {}) as Record<string, string> });
    const path = new URL(String(url)).pathname.replace(/^\/v1/, '');
    let payload: unknown = { object: 'list', data: [] };
    if (path === '/uploads') {
      const req = calls[calls.length - 1].body;
      payload = {
        asset_id: `asset_${req.filename}`,
        upload_url: `https://storage.example/put/${encodeURIComponent(req.filename)}`,
        asset_url: `https://cdn.example/uploads/${encodeURIComponent(req.filename)}`,
        content_type: req.content_type ?? 'application/octet-stream',
        expires_at: '2026-10-20T00:00:00.000Z'
      };
    } else if (path === '/media/inspect') {
      if (inspectSeconds === null) {
        return new Response(JSON.stringify({ status: 422, code: 'media_unreadable', detail: 'Could not read the media at that URL' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
      }
      payload = { object: 'media_inspection', durationSeconds: inspectSeconds, width: 1080, height: 1920, ...(inspectHasAudio === undefined ? {} : { hasAudio: inspectHasAudio }) };
    } else if (path === '/models/estimate-cost') {
      payload = { object: 'cost_estimate', model: 'm', capability: 'c', credits: 1, unit: 'total', breakdown: {} };
    } else if (path === '/account/credits') {
      payload = { account_id: 'a', balance: 10, currency: 'credits' };
    } else if (path.startsWith('/runs/') || path.endsWith('/generations') || path.endsWith('/final') || path === '/images/vectorize') {
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
    '--task', 'editing', '--bitrate', 'standard', '--no-audio'
  ];
  const gen = bodyOf(await runCli(['generate', 'video', 'relight @Video1', ...flags, '--no-wait']), '/videos/generations');
  const est = bodyOf(await runCli(['cost', 'video', 'relight @Video1', ...flags]), '/models/estimate-cost');
  const { prompt, ...genRest } = gen;
  assert.equal(prompt, 'relight @Video1');
  assert.deepEqual(genRest, est);
  assert.equal(est.generate_audio, false);
  // --bitrate has no effect on Seedance 2.5, so neither body carries it.
  assert.equal('bitrate_mode' in est, false);
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

test('Ideogram 4.5: --edit-precision reaches both bodies as edit_precision, identically', async () => {
  const flags = [
    '-m', 'image.ideogram_v4_5', '-q', 'high', '-r', '2K', '-a', '4:5',
    '-i', 'https://cdn.example/poster.png', '-i', 'https://cdn.example/ref.png', '--edit-precision', 'HIGH'
  ];
  const gen = bodyOf(await runCli(['generate', 'image', 'make the headline say "SALE"', ...flags, '--no-wait']), '/images/generations');
  const est = bodyOf(await runCli(['cost', 'image', 'make the headline say "SALE"', ...flags]), '/models/estimate-cost');
  const { prompt, ...genRest } = gen;
  assert.equal(prompt, 'make the headline say "SALE"');
  assert.deepEqual(genRest, est, 'a quote stays spendable');
  assert.equal(gen.edit_precision, 'high', 'normalised to lowercase');
  assert.equal(gen.model, 'image.ideogram_v4_5');
  assert.deepEqual(gen.image_urls, ['https://cdn.example/poster.png', 'https://cdn.example/ref.png']);
  // Unset stays unset: the API default ('regular') applies and other models never see the key.
  const plain = bodyOf(await runCli(['generate', 'image', 'a logo', '-m', 'image.ideogram_v4_5', '--no-wait']), '/images/generations');
  assert.equal('edit_precision' in plain, false);
  await assert.rejects(buildImageRequest({ editPrecision: 'max' }, passthrough), /--edit-precision must be one of: regular, high/);
});

test('Ideogram Vector: image.ideogram_vector rides the image body, and generate and cost agree', async () => {
  const flags = ['-m', 'image.ideogram_vector', '-q', 'high', '-a', '4:1', '-i', 'https://cdn.example/ref.png'];
  const gen = bodyOf(await runCli(['generate', 'image', 'a fox mark', ...flags, '--no-wait']), '/images/generations');
  const est = bodyOf(await runCli(['cost', 'image', 'a fox mark', ...flags]), '/models/estimate-cost');
  const { prompt, ...genRest } = gen;
  assert.equal(prompt, 'a fox mark');
  // The reference rides into the estimate too: with it, high is the pricier rate.
  assert.deepEqual(genRest, est, 'a quote stays spendable');
  assert.equal(gen.model, 'image.ideogram_vector');
  assert.equal(gen.image_url, 'https://cdn.example/ref.png');
  assert.equal(gen.aspect_ratio, '4:1');
});

test('generate vectorize posts image_url (+ mode only when given) to /images/vectorize under an Idempotency-Key', async () => {
  const calls = await runCli(['generate', 'vectorize', '--image', 'https://cdn.example/logo.png', '--mode', 'Simple', '--project', 'proj_1', '--no-wait']);
  const hit = calls.find((c) => c.method === 'POST' && c.url.endsWith('/images/vectorize'));
  assert.ok(hit, 'posted to /images/vectorize');
  assert.deepEqual(hit!.body, { image_url: 'https://cdn.example/logo.png', mode: 'simple', project_id: 'proj_1' });
  assert.ok(hit!.headers?.['Idempotency-Key'], 'billable route: the key rides the header');
  const plain = bodyOf(await runCli(['generate', 'vectorize', '--image', 'https://cdn.example/logo.png', '--no-wait']), '/images/vectorize');
  assert.equal('mode' in plain, false, 'unset stays unset: the API default applies');
  // A local path is uploaded first; the body carries the asset URL.
  const dir = mkdtempSync(join(tmpdir(), 'gf-vec-'));
  try {
    const file = join(dir, 'logo.png');
    writeFileSync(file, 'png');
    const uploaded = bodyOf(await runCli(['generate', 'vectorize', '--image', file, '--no-wait']), '/images/vectorize');
    assert.equal(uploaded.image_url, 'https://cdn.example/uploads/logo.png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await assert.rejects(buildVectorizeRequest({ image: 'x', mode: 'detailed' }, passthrough), /--mode must be one of: default, simple/);
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

// ─── A prompt typed after a variadic --ref-* list ────────────────────────────
// `--ref-image <urlOrPath...>` swallows every following word, so the prompt in
// `generate video -m video.seedance_2_5 --ref-video a.mov --ref-image me.jpg
// "make her dance"` landed in the image list: generate died with "missing
// required argument 'prompt'" and cost tried to upload the prompt as a file.

test('a prompt after --ref-image is recovered, identically on generate and cost', async () => {
  const flags = ['-m', 'video.seedance_2_5', '-d', '6', '--ref-video', 'https://cdn.example/a.mov', '--ref-image', 'https://cdn.example/me.jpg'];
  const genCalls = await runCli(['generate', 'video', ...flags, 'make her dance', '--no-wait']);
  const estCalls = await runCli(['cost', 'video', ...flags, 'make her dance']);
  const gen = bodyOf(genCalls, '/videos/generations');
  const est = bodyOf(estCalls, '/models/estimate-cost');
  assert.equal(gen.prompt, 'make her dance');
  assert.deepEqual(gen.reference_image_urls, ['https://cdn.example/me.jpg']);
  const { prompt: _p, ...genRest } = gen;
  assert.deepEqual(genRest, est, 'quote parity');
  assert.ok(!estCalls.some((c) => c.url.endsWith('/uploads')), 'cost never uploads the prompt');
});

test('--ref-image a.jpg b.jpg still takes both files, and a prompt after them is still recovered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genfire-refs-'));
  try {
    const a = join(dir, 'a.JPG');
    const b = join(dir, 'b b.png');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    const calls = await runCli(['generate', 'video', '-m', 'video.seedance_2_5', '--ref-image', a, b, 'make them wave', '--no-wait']);
    const gen = bodyOf(calls, '/videos/generations');
    assert.equal(gen.prompt, 'make them wave');
    assert.deepEqual(gen.reference_image_urls, ['https://cdn.example/uploads/a.JPG', 'https://cdn.example/uploads/b%20b.png']);
    // Typed by extension (any case) — never application/octet-stream.
    const uploads = calls.filter((c) => c.url.endsWith('/uploads')).map((c) => c.body);
    // (Uploads run in parallel, so their order is not fixed — the URL order above is.)
    assert.deepEqual(uploads.map((u) => [u.filename, u.content_type]).sort(), [['a.JPG', 'image/jpeg'], ['b b.png', 'image/png']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the prompt is recovered from whichever variadic list swallowed it, including trims', async () => {
  const gen = bodyOf(
    await runCli(['generate', 'video', '-m', 'video.seedance_2_5', '-d', '5', '--ref-video', 'https://cdn.example/a.mp4', '--ref-video-trim', '0:1-4', 'relight @Video1 at dusk', '--no-wait']),
    '/videos/generations'
  );
  assert.equal(gen.prompt, 'relight @Video1 at dusk');
  assert.deepEqual(gen.reference_video_trims, [{ index: 0, start: 1, end: 4 }]);
  await assert.rejects(runCli(['generate', 'video', '-m', 'video.veo_3_1', '--no-wait']), /Missing the prompt/);
});

test('speech: text after the variadic --audio-url is recovered', async () => {
  const calls = await runCli(['generate', 'speech', '-m', 'speech.seed_audio_1_0', '--audio-url', 'https://cdn.example/v.mp3', 'Hello @Audio1', '--no-wait']);
  const body = bodyOf(calls, '/audio/speech');
  assert.equal(body.text, 'Hello @Audio1');
  assert.deepEqual(body.audio_urls, ['https://cdn.example/v.mp3']);
});

test('looksLikePrompt: existing paths, URLs, issued run ids and path-shaped words are media; prose is the prompt', () => {
  const nothing = () => false;
  const everything = () => true;
  assert.equal(looksLikePrompt('make her dance', nothing), true);
  assert.equal(looksLikePrompt('dance', nothing), true);
  assert.equal(looksLikePrompt('', nothing), true, 'Recast\'s "" prompt');
  // One word with an underscore is a prompt unless it is a prefix the API issues.
  assert.equal(looksLikePrompt('slow_motion', nothing), true);
  assert.equal(looksLikePrompt('run_abc123', nothing), false);
  assert.equal(looksLikePrompt('dash_video_abc', nothing), false);
  // An EXISTING path is media however it is spelled — file or directory, spaces or none.
  assert.equal(looksLikePrompt('Screen Recording 1.mov', everything), false);
  assert.equal(looksLikePrompt('My Clips', everything), false);
  assert.equal(looksLikePrompt('slow_motion', everything), false);
  // A value that does not exist and has whitespace is prose.
  assert.equal(looksLikePrompt('My Clips', nothing), true);
  assert.equal(looksLikePrompt('make her dance to song.mp3', nothing), true);
  assert.equal(looksLikePrompt('https://cdn.example/a.png', nothing), false);
  assert.equal(looksLikePrompt('./shots/a', nothing), false);
  assert.equal(looksLikePrompt('photo.heic', nothing), false);
});

test('a one-word underscore prompt after --ref-image is recovered, not resolved as a run', async () => {
  const calls = await runCli(['generate', 'video', '-m', 'video.veo_3_1', '--ref-image', 'https://cdn.example/a.png', 'slow_motion', '--no-wait']);
  const gen = bodyOf(calls, '/videos/generations');
  assert.equal(gen.prompt, 'slow_motion');
  assert.deepEqual(gen.reference_image_urls, ['https://cdn.example/a.png']);
  assert.ok(!calls.some((c) => c.url.includes('/runs/slow_motion')), 'no run lookup for a prompt');
});

test('an existing directory with spaces after --ref-image stays media (and fails as "not a file"), never the prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genfire-dir-'));
  try {
    const clips = join(dir, 'My Clips');
    mkdirSync(clips);
    await assert.rejects(
      runCli(['generate', 'video', 'a fox', '-m', 'video.veo_3_1', '--ref-image', clips, '--no-wait']),
      /Path is not a file/
    );
    await assert.rejects(
      runCli(['generate', 'video', '-m', 'video.veo_3_1', '--ref-image', clips, '--no-wait']),
      /Missing the prompt/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverTrailingPrompt leaves an explicit prompt alone and refuses two candidates', () => {
  const opts: Record<string, unknown> = { refImage: ['a.png', 'make her dance'] };
  assert.equal(recoverTrailingPrompt('explicit', opts, VIDEO_VARIADIC_FLAGS, () => false), 'explicit');
  assert.deepEqual(opts.refImage, ['a.png', 'make her dance'], 'untouched when the positional had one');
  assert.equal(recoverTrailingPrompt(undefined, opts, VIDEO_VARIADIC_FLAGS, () => false), 'make her dance');
  assert.deepEqual(opts.refImage, ['a.png']);
  const only: Record<string, unknown> = { refImage: ['make her dance'] };
  recoverTrailingPrompt(undefined, only, VIDEO_VARIADIC_FLAGS, () => false);
  assert.equal(only.refImage, undefined, 'an emptied list is dropped');
  assert.throws(
    () => recoverTrailingPrompt(undefined, { refImage: ['a.png', 'one idea'], refAudio: ['b.mp3', 'another idea'] }, VIDEO_VARIADIC_FLAGS, () => false),
    /read as the prompt/
  );
});

// ─── Genjudo: the clip's own sound + "Match the clip" ────────────────────────
// The web Genjudo keeps the clip's sound by default on Motion and Edit, and its
// "Match the clip" sends the clip's frame and measured length. The CLI sent the
// API defaults (a generated soundtrack, 16:9, 5 s) instead.

test('--task reference with one clip and no -a/-d matches the clip, keeps its sound, and quotes what it charges', async () => {
  inspectSeconds = 7.4;
  const flags = ['-m', 'video.seedance_2_5', '--task', 'reference', '--ref-video', 'https://cdn.example/dance.mp4', '--ref-image', 'https://cdn.example/me.jpg'];
  const gen = bodyOf(await runCli(['generate', 'video', 'Transfer the motion in @Video1 onto @Image1', ...flags, '--no-wait']), '/videos/generations');
  const est = bodyOf(await runCli(['cost', 'video', ...flags]), '/models/estimate-cost');
  const { prompt: _p, ...genRest } = gen;
  assert.deepEqual(genRest, est, 'quote parity');
  assert.equal(est.aspect_ratio, 'auto');
  assert.equal(est.duration, 8, 'rounded UP with the sound kept too: it bills what renders');
  assert.equal(est.follow_source, true);
  assert.equal(est.keep_source_audio, true);
  assert.equal(est.generate_audio, false);
});

test('Match the clip: a trim window is what is measured; every sound choice rounds up; -a / -d opt out', async () => {
  inspectSeconds = 7.4;
  const clip = ['-m', 'video.seedance_2_5', '--task', 'reference', '--ref-video', 'https://cdn.example/dance.mp4'];
  const trimmed = bodyOf(await runCli(['cost', 'video', ...clip, '--ref-video-trim', '0:1-6.5']), '/models/estimate-cost');
  assert.equal(trimmed.duration, 6, 'a 5.5 s window with the clip\'s sound kept renders (and bills) 6 s');
  // 0.2–8.2 is 7.999… s in floats: rounded to the millisecond first, so 8 (what the API bills).
  inspectSeconds = 12;
  const window = bodyOf(await runCli(['cost', 'video', ...clip, '--ref-video-trim', '0:0.2-8.2']), '/models/estimate-cost');
  assert.equal(window.duration, 8);
  inspectSeconds = 7.4;
  const generated = bodyOf(await runCli(['cost', 'video', ...clip, '--no-keep-clip-audio']), '/models/estimate-cost');
  assert.equal(generated.duration, 8);
  // Explicit, or the API's one-clip default would put the clip's sound back on.
  assert.equal(generated.keep_source_audio, false);
  assert.equal('generate_audio' in generated, false);
  const fixed = bodyOf(await runCli(['cost', 'video', ...clip, '-a', '9:16', '-d', '6']), '/models/estimate-cost');
  assert.equal(fixed.aspect_ratio, '9:16');
  assert.equal(fixed.duration, 6);
  assert.equal('follow_source' in fixed, false);
  inspectSeconds = 2.1;
  assert.equal(bodyOf(await runCli(['cost', 'video', ...clip]), '/models/estimate-cost').duration, 4, 'clamped to one pass');
  inspectSeconds = null;
  await assert.rejects(runCli(['cost', 'video', ...clip]), /Could not measure the --ref-video .*Pass -d <seconds>/);
  inspectSeconds = 7.4;
});

test('matchClipSeconds rounds UP whatever the sound, to the millisecond first, clamped to 4-30', () => {
  assert.equal(matchClipSeconds(7.4), 8, 'a kept-sound 7.4 s clip bills 8, never 7');
  assert.equal(matchClipSeconds(4.5), 5, 'live 2026-10-12: a 4.5 s window rendered 5.06 s');
  assert.equal(matchClipSeconds(12.9), 13);
  assert.equal(matchClipSeconds(12.1), 13);
  // Millisecond rounding first, like the backend: float noise never adds a second.
  assert.equal(matchClipSeconds(8.2 - 0.2), 8);
  assert.equal(matchClipSeconds(16.1 - 1.1), 15);
  assert.equal(matchClipSeconds(8.0000001), 8);
  assert.equal(matchClipSeconds(30.0004), 30);
  assert.equal(matchClipSeconds(2.1), 4);
  assert.equal(matchClipSeconds(45), 30);
});

test('editing sends the clip-sound fields and auto frame, but never follow_source or a measured length', async () => {
  const flags = ['-m', 'video.seedance_2_5', '--task', 'editing', '--ref-video', 'https://cdn.example/take.mp4'];
  const gen = bodyOf(await runCli(['generate', 'video', 'relight @Video1', ...flags, '--no-wait']), '/videos/generations');
  const est = bodyOf(await runCli(['cost', 'video', 'relight @Video1', ...flags]), '/models/estimate-cost');
  const { prompt: _p, ...genRest } = gen;
  assert.deepEqual(genRest, est);
  assert.equal(est.keep_source_audio, true);
  assert.equal(est.aspect_ratio, 'auto');
  for (const key of ['follow_source', 'duration']) assert.equal(key in est, false);
  const ext = bodyOf(await runCli(['cost', 'video', ...flags.slice(0, 3), 'extension', ...flags.slice(4), '-d', '5']), '/models/estimate-cost');
  for (const key of ['keep_source_audio', 'follow_source']) assert.equal(key in ext, false);
});

test('the CLI fills the one-clip defaults under exactly the API\'s conditions', async () => {
  inspectSeconds = 7.4;
  inspectHasAudio = true;
  const two = await bothBodies(['-m', 'video.seedance_2_5', '--ref-video', 'https://cdn.example/a.mp4', '--ref-video', 'https://cdn.example/b.mp4', '--ref-image', 'https://cdn.example/me.jpg']);
  for (const key of ['aspect_ratio', 'duration', 'follow_source', 'keep_source_audio', 'generate_audio']) assert.equal(key in two, false, `two clips: no ${key}`);
  const twoKept = await bothBodies(['-m', 'video.seedance_2_5', '--ref-video', 'https://cdn.example/a.mp4', '--ref-video', 'https://cdn.example/b.mp4', '--keep-clip-audio', '-d', '6']);
  assert.equal(twoKept.keep_source_audio, true, 'an explicit flag is still sent');
  // A --ref-audio voice: the clip's sound is not kept; the match rounds UP as always.
  const voiced = await bothBodies([...SD25_CLIP, '--ref-audio', 'https://cdn.example/voice.mp3']);
  assert.equal('keep_source_audio' in voiced, false);
  assert.equal('generate_audio' in voiced, false);
  assert.equal(voiced.duration, 8);
  assert.equal(voiced.follow_source, true);
  // A clip with no soundtrack: nothing to keep, generated sound, still rounded UP.
  inspectHasAudio = false;
  const mute = await bothBodies(SD25_CLIP);
  assert.equal('keep_source_audio' in mute, false);
  assert.equal(mute.duration, 8);
  const muteEdit = await bothBodies(['-m', 'video.seedance_2_5', '--task', 'editing', '--ref-video', 'https://cdn.example/take.mp4'], 'relight @Video1');
  assert.equal('keep_source_audio' in muteEdit, false);
  assert.equal(muteEdit.aspect_ratio, 'auto');
  inspectHasAudio = true;
  // An explicit ratio is the caller's: the CLI fills no length or follow_source for it and leaves the
  // call to the API — which still follows the clip when the ratio IS the clip's own (a 9:16 phone clip
  // with -a 9:16) and renders 5 s for any other. Either way cost and generate send the same body.
  const portrait = await bothBodies([...SD25_CLIP, '-a', '9:16']);
  assert.equal(portrait.aspect_ratio, '9:16');
  for (const key of ['duration', 'follow_source']) assert.equal(key in portrait, false);
  assert.equal(portrait.keep_source_audio, true);
  // `-a auto` still follows.
  const auto = await bothBodies([...SD25_CLIP, '-a', 'auto']);
  assert.equal(auto.duration, 8);
  assert.equal(auto.follow_source, true);
  // An unreadable clip on an edit: the sound is left to the API (same rule, its own probe).
  inspectSeconds = null;
  const unread = await bothBodies(['-m', 'video.seedance_2_5', '--task', 'editing', '--ref-video', 'https://cdn.example/take.mp4'], 'relight @Video1');
  for (const key of ['keep_source_audio', 'generate_audio']) assert.equal(key in unread, false);
  inspectSeconds = 7.4;
});

test('Seedance 2.5: --image beside reference media is sent as given — the API folds it into the references', async () => {
  const m = { model: 'video.seedance_2_5', image: 'a.png' };
  assert.doesNotThrow(() => validateVideoFlags({ ...m, refVideo: ['b.mp4'] }));
  assert.doesNotThrow(() => validateVideoFlags({ ...m, refImage: ['b.png'] }));
  // Audio alone is still refused (never the only reference) — before any upload.
  assert.throws(() => validateVideoFlags({ ...m, refAudio: ['v.mp3'] }), /--ref-audio/);
  // Same body for cost and generate: the start frame AND the pool both ride.
  const body = await bothBodies(['-m', 'video.seedance_2_5', '-i', 'https://cdn.example/frame.jpg', '--ref-image', 'https://cdn.example/me.jpg', '-d', '5'], 'she waves at @Image1');
  assert.equal(body.image_url, 'https://cdn.example/frame.jpg');
  assert.deepEqual(body.reference_image_urls, ['https://cdn.example/me.jpg']);
});

test('Genjudo flag validation fails before anything uploads', () => {
  const g = { model: 'video.seedance_2_5', refVideo: ['a.mp4'] };
  assert.throws(() => validateVideoFlags({ ...g, task: 'editing', refVideo: ['a.mp4', 'b.mp4'] }), /ONE clip at a time/);
  assert.throws(() => validateVideoFlags({ ...g, task: 'extension', refVideo: ['a.mp4', 'b.mp4'] }), /ONE clip at a time/);
  assert.throws(() => validateVideoFlags({ model: 'video.veo_3_1', refVideo: ['a.mp4'], keepClipAudio: true }), /Genjudo option/);
  assert.throws(() => validateVideoFlags({ model: 'video.seedance_2_5', keepClipAudio: true }), /pass the clip with --ref-video/);
  assert.doesNotThrow(() => validateVideoFlags({ ...g, task: 'reference', refVideo: ['a.mp4', 'b.mp4'] }));
  assert.doesNotThrow(() => validateVideoFlags({ model: 'video.veo_3_1', keepClipAudio: false }));
});

test('--keep-clip-audio on --task extension has no effect: not refused, and nothing is sent for it', async () => {
  assert.doesNotThrow(() => validateVideoFlags({ model: 'video.seedance_2_5', refVideo: ['a.mp4'], task: 'extension', keepClipAudio: true }));
  const body = await bothBodies(['-m', 'video.seedance_2_5', '--task', 'extension', '--ref-video', 'https://cdn.example/take.mp4', '--keep-clip-audio'], 'continue @Video1');
  for (const key of ['keep_source_audio', 'generate_audio']) assert.equal(key in body, false, `${key} is not sent on extension`);
});

test('Seedance 2.5: --bitrate is not refused (and not sent); cost -n > 1 is sent for the API to clamp', async () => {
  for (const bitrate of ['high', 'standard']) {
    assert.doesNotThrow(() => validateVideoFlags({ model: 'video.seedance_2_5', bitrate }));
    const body = await bothBodies(['-m', 'video.seedance_2_5', '--bitrate', bitrate, '-d', '5'], 'a fox runs');
    assert.equal('bitrate_mode' in body, false, `--bitrate ${bitrate} has no effect on 2.5`);
  }
  assert.doesNotThrow(() => validateVideoFlags({ model: 'VIDEO.SEEDANCE_2_5', bitrateMode: 'high' }));
  // Seedance 2.0 Standard/Fast take it as before.
  assert.equal((await bothBodies(['-m', 'video.seedance_2_0', '--bitrate', 'high'], 'a fox runs')).bitrate_mode, 'high');
  // A value that is neither is still a local error.
  assert.throws(() => validateVideoFlags({ model: 'video.seedance_2_0', bitrate: 'ultra' }), /standard or high/);
  // Count: sent as given on every model.
  assert.equal(videoEstimateCount('video.seedance_2_5', '2'), 2);
  assert.equal(videoEstimateCount('video.seedance_2_5', undefined), undefined);
  assert.equal(videoEstimateCount('video.veo_3_1', '3'), 3);
  assert.equal(bodyOf(await runCli(['cost', 'video', 'x', '-m', 'video.seedance_2_5', '-n', '3']), '/models/estimate-cost').count, 3);
  assert.equal(bodyOf(await runCli(['cost', 'video', 'x', '-m', 'video.veo_3_1', '-n', '3']), '/models/estimate-cost').count, 3);
});

// ─── Clip sound in the REQUEST BODY, per task (and with no --task) ───────────
// A video.seedance_2_5 run with a clip and no --task runs as `reference` (the
// API leaves the task to the model's default), so it must carry the same
// clip-sound and Match-the-clip fields as an explicit `--task reference` —
// --keep-clip-audio used to be dropped silently there.

async function bothBodies(flags: string[], prompt = 'Transfer the motion in @Video1 onto @Image1') {
  const gen = bodyOf(await runCli(['generate', 'video', prompt, ...flags, '--no-wait']), '/videos/generations');
  const est = bodyOf(await runCli(['cost', 'video', prompt, ...flags]), '/models/estimate-cost');
  const { prompt: _p, ...genRest } = gen;
  assert.deepEqual(genRest, est, `quote parity for ${flags.join(' ')}`);
  return est;
}

const SD25_CLIP = ['-m', 'video.seedance_2_5', '--ref-video', 'https://cdn.example/dance.mp4', '--ref-image', 'https://cdn.example/me.jpg'];

test('no --task: the clip\'s sound is kept by default and the clip is matched, exactly like --task reference', async () => {
  inspectSeconds = 7.4;
  const none = await bothBodies(SD25_CLIP);
  const reference = await bothBodies([...SD25_CLIP, '--task', 'reference']);
  assert.equal('task' in none, false, 'no task is invented on the wire');
  const { task, ...referenceRest } = reference;
  assert.equal(task, 'reference');
  assert.deepEqual(none, referenceRest);
  assert.equal(none.keep_source_audio, true);
  assert.equal(none.generate_audio, false);
  assert.equal(none.aspect_ratio, 'auto');
  assert.equal(none.duration, 8);
  assert.equal(none.follow_source, true);
});

test('no --task: --keep-clip-audio and --no-keep-clip-audio take effect in the body', async () => {
  inspectSeconds = 7.4;
  const kept = await bothBodies([...SD25_CLIP, '--keep-clip-audio', '-d', '6']);
  assert.equal(kept.keep_source_audio, true);
  assert.equal(kept.generate_audio, false);
  assert.equal(kept.duration, 6);
  assert.equal('follow_source' in kept, false, '-d opts out of Match the clip');
  const generated = await bothBodies([...SD25_CLIP, '--no-keep-clip-audio']);
  assert.equal(generated.keep_source_audio, false, 'the opt-out is explicit: the API defaults a one-clip run to the clip\'s sound');
  assert.equal('generate_audio' in generated, false);
  assert.equal(generated.duration, 8, 'rounded UP, the same as with the clip\'s sound kept');
});

test('--task editing keeps the sound in the body; --task extension never does', async () => {
  const take = ['-m', 'video.seedance_2_5', '--ref-video', 'https://cdn.example/take.mp4'];
  const editing = await bothBodies([...take, '--task', 'editing'], 'relight @Video1');
  assert.equal(editing.keep_source_audio, true);
  assert.equal(editing.generate_audio, false);
  assert.equal(editing.aspect_ratio, 'auto');
  for (const key of ['follow_source', 'duration']) assert.equal(key in editing, false);
  const editingGenerated = await bothBodies([...take, '--task', 'editing', '--no-keep-clip-audio'], 'relight @Video1');
  assert.equal(editingGenerated.keep_source_audio, false);
  assert.equal('generate_audio' in editingGenerated, false);
  const extension = await bothBodies([...take, '--task', 'extension', '-d', '5'], 'continue @Video1');
  // Extension gets none of the one-clip defaults — the API applies none there either.
  for (const key of ['keep_source_audio', 'follow_source', 'generate_audio', 'aspect_ratio']) assert.equal(key in extension, false);
  // keep_source_audio has no effect on extension — the opt-out is not sent there either.
  const extensionOptOut = await bothBodies([...take, '--task', 'extension', '-d', '5', '--no-keep-clip-audio'], 'continue @Video1');
  assert.equal('keep_source_audio' in extensionOptOut, false);
  // --no-audio alone already sets generate_audio, which the API reads as the caller's choice.
  const silent = await bothBodies([...take, '--task', 'editing', '--no-audio'], 'relight @Video1');
  assert.equal(silent.generate_audio, false);
  assert.equal('keep_source_audio' in silent, false);
  // ...nor the opt-in: no effect there, so not refused and nothing is sent.
  const extensionOptIn = await bothBodies([...take, '--task', 'extension', '-d', '5', '--keep-clip-audio'], 'continue @Video1');
  for (const key of ['keep_source_audio', 'generate_audio']) assert.equal(key in extensionOptIn, false);
});
