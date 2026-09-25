import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { buildImageStyleTrainBody, buildLoraTrainBody, registerTrainingCommands } from './training.js';
import { CliError } from '../errors.js';

// The training routes are billed and sit behind `requireIdempotencyKey`, and
// `POST /v1/loras` refuses to run without `rights_attested: true`. These pin the
// wire shape and the routes so a flag rename can't silently drop a field.

const urls = (n: number, ext = 'png') => Array.from({ length: n }, (_, i) => `https://cdn.example.test/${i}.${ext}`);

async function runCli(argv: string[]): Promise<Array<{ url: string; init: RequestInit }>> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'x', object: 'cost_estimate', credits: 1, breakdown: {}, status: 'queued', name: 'n' }), { status: 200 });
  }) as typeof fetch;
  try {
    const program = new Command();
    program.exitOverride();
    registerTrainingCommands(program);
    await program.parseAsync(['node', 'genfire', ...argv]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GENFIRE_API_KEY; else process.env.GENFIRE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GENFIRE_API_BASE_URL; else process.env.GENFIRE_API_BASE_URL = originalBase;
  }
  return calls;
}

test('image style train body carries every flag under its API name', () => {
  const body = buildImageStyleTrainBody('Ink', urls(5), {
    kind: 'subject', trigger: 'inkwash', steps: '1200', base: 'z_image_turbo', skill: 'sk_1', team: 'team_1'
  });
  assert.deepEqual(body, {
    name: 'Ink',
    image_urls: urls(5),
    kind: 'subject',
    base_model: 'z_image_turbo',
    steps: 1200,
    trigger_word: 'inkwash',
    skill_id: 'sk_1',
    team_id: 'team_1'
  });
});

test('image style train rejects an image count outside 5-60 before any upload', () => {
  assert.throws(() => buildImageStyleTrainBody('Ink', urls(4), {}), CliError);
  assert.throws(() => buildImageStyleTrainBody('Ink', urls(61), {}), CliError);
});

test('lora train body: rights attested, captions become {url, caption}, quote + team ride along', () => {
  const body = buildLoraTrainBody('Look', urls(2, 'mp4'), {
    kind: 'subject', rightsAttested: true, caption: ['1:a woman turns'], steps: '2000', rank: '32',
    frameCount: '73', aspectRatio: '9:16', resumeFrom: 'lora_0', quote: 'q_1', team: 'team_1'
  });
  assert.deepEqual(body, {
    name: 'Look',
    kind: 'subject',
    rights_attested: true,
    clips: [urls(2, 'mp4')[0], { url: urls(2, 'mp4')[1], caption: 'a woman turns' }],
    steps: 2000,
    rank: 32,
    aspect_ratio: '9:16',
    frame_count: 73,
    resume_from_lora_id: 'lora_0',
    team_id: 'team_1',
    quote_token: 'q_1'
  });
});

test('lora train refuses without --rights-attested, and clips + zip together', () => {
  assert.throws(() => buildLoraTrainBody('L', urls(1, 'mp4'), { kind: 'style' }), /rights-attested/);
  assert.throws(
    () => buildLoraTrainBody('L', urls(1, 'mp4'), { kind: 'style', rightsAttested: true, datasetZip: 'https://x/d.zip' }),
    /not both/
  );
  assert.throws(() => buildLoraTrainBody('L', urls(1, 'mp4'), { kind: 'style', rightsAttested: true, resumeFrom: 'l' }), /subject/);
});

test('trained-models train POSTs /loras with an Idempotency-Key header', async () => {
  const calls = await runCli([
    'trained-models', 'train', 'Look', '--kind', 'style', '--rights-attested',
    '--clip', 'https://cdn.example.test/a.mp4', '--quote', 'q_1'
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/loras');
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(headers['Idempotency-Key'], 'Idempotency-Key header is required by the route');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    name: 'Look', kind: 'style', rights_attested: true, clips: ['https://cdn.example.test/a.mp4'], quote_token: 'q_1'
  });
});

test('estimates hit the free estimate-cost routes with the priced fields only', async () => {
  const video = await runCli(['trained-models', 'estimate', '--kind', 'subject', '--steps', '1500']);
  assert.equal(video[0].url, 'https://api.example.test/v1/loras/estimate-cost');
  assert.deepEqual(JSON.parse(String(video[0].init.body)), { kind: 'subject', steps: 1500 });

  const image = await runCli(['image-styles', 'estimate', '-n', '12', '--base', 'flux']);
  assert.equal(image[0].url, 'https://api.example.test/v1/image-styles/estimate-cost');
  assert.deepEqual(JSON.parse(String(image[0].init.body)), { image_count: 12, base_model: 'flux' });
});

test('style-skills train POSTs under the skill with an Idempotency-Key', async () => {
  const calls = await runCli(['style-skills', 'train', 'sk_9', '--steps', '800']);
  assert.equal(calls[0].url, 'https://api.example.test/v1/style-skills/sk_9/train');
  assert.ok((calls[0].init.headers as Record<string, string>)['Idempotency-Key']);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { steps: 800 });
});
