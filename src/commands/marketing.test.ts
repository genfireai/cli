import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { registerMarketingCommand, queryString } from './marketing.js';
import { registerTasksCommand } from './tasks.js';
import { registerAdsCommand, parseRemixChange, parseRemixImageChange } from './ads.js';
import { registerFacelessReelsCommand } from './faceless-reels.js';
import { registerWorkflowCommands } from './workflow.js';

// Wiring tests for the marketing / tasks / ads-remix / ads-manager / channel
// episode / canvas-list commands: each drives the real commander tree against a
// stubbed fetch and pins the method, path and body the API contract expects.

interface Captured { url: string; method: string; body: any; headers: Record<string, string> }

async function run(
  register: (program: Command) => void,
  argv: string[],
  respond: (req: Captured) => unknown = () => ({ object: 'list', data: [] })
): Promise<Captured[]> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GENFIRE_API_KEY;
  const originalBase = process.env.GENFIRE_API_BASE_URL;
  process.env.GENFIRE_API_KEY = 'test-key';
  process.env.GENFIRE_API_BASE_URL = 'https://api.example.test/v1';
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const req: Captured = {
      url: String(url),
      method: String(init.method),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>
    };
    calls.push(req);
    return new Response(JSON.stringify(respond(req)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const program = new Command();
    program.exitOverride();
    register(program);
    await program.parseAsync(['node', 'genfire', ...argv]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GENFIRE_API_KEY; else process.env.GENFIRE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GENFIRE_API_BASE_URL; else process.env.GENFIRE_API_BASE_URL = originalBase;
  }
  return calls;
}

test('queryString drops unset values and encodes the rest', () => {
  assert.equal(queryString({ a: undefined, b: '', c: false }), '');
  assert.equal(queryString({ search: 'red shoe', limit: 5, requires_avatar: 'true' }), '?search=red+shoe&limit=5&requires_avatar=true');
});

test('marketing templates maps flags onto the query the API reads', async () => {
  const calls = await run(registerMarketingCommand, [
    'marketing', 'templates', '--ad-format', 'ugc', '--media-type', 'video', '--requires-avatar', '-l', '10', '-q', 'unboxing'
  ]);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(calls[0].method, 'GET');
  assert.equal(url.pathname, '/v1/marketing/templates');
  assert.equal(url.searchParams.get('ad_format'), 'ugc');
  assert.equal(url.searchParams.get('media_type'), 'video');
  assert.equal(url.searchParams.get('requires_avatar'), 'true');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.get('search'), 'unboxing');
});

test('marketing catalog reads all four catalog routes', async () => {
  const calls = await run(registerMarketingCommand, ['marketing', 'catalog', '--mode', 'video']);
  const paths = calls.map((c) => new URL(c.url).pathname).sort();
  assert.deepEqual(paths, ['/v1/marketing/ad-formats', '/v1/marketing/formats', '/v1/marketing/hooks', '/v1/marketing/settings']);
  const hooks = calls.find((c) => c.url.includes('/hooks'))!;
  assert.equal(new URL(hooks.url).searchParams.get('mode'), 'video');
});

test('marketing add-product posts brand_id + url', async () => {
  const calls = await run(
    registerMarketingCommand,
    ['marketing', 'add-product', '--brand', 'br_1', '--url', 'https://shop.example/p/1'],
    () => ({ id: 'prod_1', name: 'Shoe' })
  );
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { brand_id: 'br_1', url: 'https://shop.example/p/1' });
});

test('tasks create sends the documented wire fields', async () => {
  const calls = await run(
    registerTasksCommand,
    ['tasks', 'create', 'Summarise yesterday', '--cadence', 'weekly', '--time', '09:30', '--timezone', 'Europe/London', '--max-credits', '50', '--email'],
    () => ({ id: 'task_1', cadence: 'weekly', delivery: { email: true, slack: false } })
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(new URL(calls[0].url).pathname, '/v1/tasks');
  assert.deepEqual(calls[0].body, {
    prompt: 'Summarise yesterday',
    cadence: 'weekly',
    time: '09:30',
    timezone: 'Europe/London',
    max_credits_per_run: 50,
    delivery: { email: true, slack: false }
  });
});

test('tasks update only sends the channel that was named', async () => {
  const calls = await run(
    registerTasksCommand,
    ['tasks', 'update', 'task_1', '--pause', '--slack', 'on'],
    () => ({ id: 'task_1', active: false, delivery: { email: true, slack: true } })
  );
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(new URL(calls[0].url).pathname, '/v1/tasks/task_1');
  assert.deepEqual(calls[0].body, { active: false, delivery: { slack: true } });
});

test('parseRemixChange splits WHAT: DESCRIPTION', () => {
  assert.deepEqual(parseRemixChange('location: a rooftop at dusk'), { what: 'location', description: 'a rooftop at dusk' });
  assert.deepEqual(parseRemixChange('golden hour light'), { description: 'golden hour light' });
  assert.deepEqual(parseRemixImageChange('outfit=https://x.test/j.png'), { what: 'outfit', source: 'https://x.test/j.png' });
  assert.throws(() => parseRemixImageChange('outfit'));
});

test('ads remix quotes by default (dry_run) with the 720p draft tier and no idempotency key', async () => {
  const calls = await run(
    registerAdsCommand,
    ['ads', 'remix', 'https://cdn.example/ad.mp4', '--change', 'location: a rooftop at dusk', '--preset', 'golden-hour',
      '--change-image', 'outfit=https://cdn.example/jacket.png', '--audio', 'original'],
    () => ({ object: 'ad_remix_plan', dry_run: true, estimated_credits: 120 })
  );
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/v1/ads/remix');
  assert.equal(calls[0].headers['Idempotency-Key'], undefined);
  assert.deepEqual(calls[0].body, {
    source_video_url: 'https://cdn.example/ad.mp4',
    changes: [
      { what: 'location', description: 'a rooftop at dusk' },
      { preset: 'golden-hour' },
      { what: 'outfit', image_url: 'https://cdn.example/jacket.png' }
    ],
    audio: 'original',
    resolution: '720p',
    dry_run: true
  });
});

test('ads remix --run launches with an Idempotency-Key header', async () => {
  const calls = await run(
    registerAdsCommand,
    ['ads', 'remix', 'https://cdn.example/ad.mp4', '--change', 'language: Spanish', '--run', '-r', '1080p'],
    () => ({ id: 'run_1', status: 'queued' })
  );
  assert.equal(calls[0].body.dry_run, false);
  assert.equal(calls[0].body.resolution, '1080p');
  assert.ok(calls[0].headers['Idempotency-Key']);
});

test('ads manager pause refuses without --yes and never calls the API', async () => {
  let err: unknown;
  let calls: Captured[] = [];
  try {
    calls = await run(registerAdsCommand, ['ads', 'manager', 'pause', 'cmp_1']);
  } catch (e) {
    err = e;
  }
  assert.match(String((err as Error)?.message), /--yes/);
  assert.equal(calls.length, 0);
});

test('ads manager budget posts daily_budget when confirmed', async () => {
  const calls = await run(
    registerAdsCommand,
    ['ads', 'manager', 'budget', 'adset_1', '--daily', '20', '--yes'],
    () => ({ id: 'adset_1', previous_daily_budget: 30, daily_budget: 20 })
  );
  assert.equal(new URL(calls[0].url).pathname, '/v1/adsmanager/entities/adset_1/budget');
  assert.deepEqual(calls[0].body, { daily_budget: 20 });
});

test('channel add-episode posts overrides with an Idempotency-Key', async () => {
  const calls = await run(
    registerFacelessReelsCommand,
    ['faceless-reels', 'subscriptions', 'add-episode', 'sub_1', 'The lost city', '--aspect-ratio', '16:9', '-d', '90', '--captions', 'off', '--no-fast'],
    () => ({ id: 'run_1', status: 'queued' })
  );
  assert.equal(new URL(calls[0].url).pathname, '/v1/faceless-reels/subscriptions/sub_1/episodes');
  assert.ok(calls[0].headers['Idempotency-Key']);
  assert.deepEqual(calls[0].body, {
    topic: 'The lost city', aspect_ratio: '16:9', target_duration_sec: 90, captions_on: false, fast_mode: false
  });
});

test('workflow mine lists the canvas collection', async () => {
  const calls = await run(registerWorkflowCommands, ['workflow', 'mine']);
  assert.equal(new URL(calls[0].url).pathname, '/v1/user-workflows');
});
