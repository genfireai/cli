import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { buildProjectItems, registerProjectsCommand } from './projects.js';
import { registerWorkspacesCommand } from './workspaces.js';
import { registerMoodboardsCommand } from './moodboards.js';

// Projects, workspaces and moodboards go straight through publicApiRequest (the
// pinned SDK has no methods for them), so these tests drive the real commander
// wiring against a stubbed fetch and pin method, path and body — the parts the
// API 400s on when they drift.

interface Captured { url: string; method: string; body: unknown }

async function runCli(argv: string[], response: unknown = { object: 'list', data: [] }): Promise<Captured[]> {
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
    });
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    const program = new Command().exitOverride();
    registerProjectsCommand(program);
    registerWorkspacesCommand(program);
    registerMoodboardsCommand(program);
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

const project = { id: 'col_1', object: 'project', name: 'Spring', item_count: 3, added: 2, removed: 1 };

test('projects add sends { items: [{ asset_id, asset_type }] } to POST /projects/:id/items', async () => {
  const calls = await runCli(
    ['projects', 'add', 'col_1', '--image', 'img_a', '--image', 'img_b', '--video', 'vid_1', '--element', 'el_1'],
    project,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.example.test/v1/projects/col_1/items');
  assert.deepEqual(calls[0].body, {
    items: [
      { asset_id: 'img_a', asset_type: 'image' },
      { asset_id: 'img_b', asset_type: 'image' },
      { asset_id: 'vid_1', asset_type: 'video' },
      { asset_id: 'el_1', asset_type: 'element' },
    ],
  });
});

test('buildProjectItems refuses an empty set and URLs in place of ids', () => {
  assert.throws(() => buildProjectItems({}), /at least one asset/);
  assert.throws(() => buildProjectItems({ image: ['https://cdn.example/x.png'] }), /asset's id, not its URL/);
  assert.deepEqual(buildProjectItems({ audio: ['aud_1'], title: 'VO' }), [
    { asset_id: 'aud_1', asset_type: 'audio', title: 'VO' },
  ]);
});

test('projects remove sends asset_ids in the DELETE body', async () => {
  const calls = await runCli(['projects', 'remove', 'col_1', 'img_a', 'vid_1'], project);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.example.test/v1/projects/col_1/items');
  assert.deepEqual(calls[0].body, { asset_ids: ['img_a', 'vid_1'] });
});

test('projects update --no-parent sends parent_id: null; create sends parent_id', async () => {
  const up = await runCli(['projects', 'update', 'col_1', '--brief', 'Pastel spring', '--no-parent'], project);
  assert.equal(up[0].method, 'PATCH');
  assert.deepEqual(up[0].body, { brief: 'Pastel spring', parent_id: null });

  const create = await runCli(['projects', 'create', 'Shots', '--parent', 'col_1', '-d', 'b-roll'], project);
  assert.equal(create[0].method, 'POST');
  assert.equal(create[0].url, 'https://api.example.test/v1/projects');
  assert.deepEqual(create[0].body, { name: 'Shots', description: 'b-roll', parent_id: 'col_1' });
});

test('projects list --parent root passes parent_id as a query param', async () => {
  const calls = await runCli(['projects', 'list', '--parent', 'root']);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.example.test/v1/projects?parent_id=root');
});

test('workspaces get reads GET /teams/:teamId', async () => {
  const calls = await runCli(['workspaces', 'get', 'team 1'], {
    id: 'team 1', object: 'team', name: 'Agency', role: 'admin', is_owner: false, member_count: 2,
    seat_limit: 5, pool: { balance: 100, currency: 'credits' }, created_at: null, updated_at: null,
  });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.example.test/v1/teams/team%201');
});

test('moodboards fork POSTs to the preset fork route with no body', async () => {
  const calls = await runCli(['moodboards', 'fork', 'preset_1'], {
    id: 'mb_1', object: 'moodboard', name: 'Noir', image_count: 0, images: [], analysis: null,
    guidelines: null, created_at: null, updated_at: null,
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.example.test/v1/moodboards/presets/preset_1/fork');
  assert.equal(calls[0].body, undefined);
});
