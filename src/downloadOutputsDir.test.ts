import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadOutputs } from './runHelpers.js';

const fakeFetch = (async () => new Response('AUDIO', { status: 200 })) as unknown as typeof fetch;
const one = [{ url: 'https://example.test/a.mp3', suggestedName: 'run_x.mp3' }] as any;

test('single output with -o ending in a slash saves inside that directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gf-dl-'));
  const written = await downloadOutputs(one, join(root, 'out') + '/', { fetchImpl: fakeFetch });
  assert.deepEqual(written, [join(root, 'out', 'run_x.mp3')]);
  assert.equal(await readFile(written[0], 'utf8'), 'AUDIO');
});

test('single output with -o naming an existing directory saves inside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gf-dl-'));
  await mkdir(join(root, 'existing'));
  const written = await downloadOutputs(one, join(root, 'existing'), { fetchImpl: fakeFetch });
  assert.deepEqual(written, [join(root, 'existing', 'run_x.mp3')]);
});

test('single output with -o naming a file still writes that exact file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gf-dl-'));
  const target = join(root, 'nested', 'song.mp3');
  const written = await downloadOutputs(one, target, { fetchImpl: fakeFetch });
  assert.deepEqual(written, [target]);
  assert.equal(await readFile(target, 'utf8'), 'AUDIO');
});
