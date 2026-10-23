import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVideoRequest, isKling4Alias, parseMultiPrompt, validateVideoFlags } from './generationRequests.js';

// Kling 4.0 (video.kling_v4 / video.kling_v4_flash): up to 7 elements, shots
// of 1-30 s, and no audio toggle — the API's limits, checked before anything
// uploads. Kling O3 keeps its 3 elements and 1-15 s shots.

const passthrough = async (input: string) => (input.startsWith('http') ? input : `https://cdn.example/${input}`);

function elementsFile(count: number): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'genfire-k4-'));
  const path = join(dir, 'elements.json');
  writeFileSync(path, JSON.stringify(Array.from({ length: count }, (_, i) => ({ frontal_image_url: `https://cdn.example/el_${i}.png` }))));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('isKling4Alias names both Kling 4 aliases and nothing else', () => {
  assert.equal(isKling4Alias('video.kling_v4'), true);
  assert.equal(isKling4Alias('video.kling_v4_flash'), true);
  assert.equal(isKling4Alias('video.kling_o3'), false);
  assert.equal(isKling4Alias('video.kling_v3'), false);
  assert.equal(isKling4Alias(undefined), false);
});

test('multi-prompt shots run 1-30 s on Kling 4.0, 1-15 s elsewhere', () => {
  assert.deepEqual(parseMultiPrompt(['25:a long take'], 'video.kling_v4'), [{ prompt: 'a long take', duration: '25' }]);
  assert.throws(() => parseMultiPrompt(['31:too long'], 'video.kling_v4'), /1-30/);
  assert.throws(() => parseMultiPrompt(['20:too long'], 'video.kling_o3'), /1-15/);
  assert.doesNotThrow(() => validateVideoFlags({ model: 'video.kling_v4', multiPrompt: ['20:wide', '10:close'] }));
});

test('--elements-file takes up to 7 on Kling 4.0, 3 on Kling O3', async () => {
  const seven = elementsFile(7);
  try {
    const body = await buildVideoRequest({ model: 'video.kling_v4', elementsFile: seven.path }, passthrough);
    assert.equal((body.elements as unknown[]).length, 7);
    await assert.rejects(buildVideoRequest({ model: 'video.kling_o3', elementsFile: seven.path }, passthrough), /1-3 Kling O3/);
  } finally {
    seven.cleanup();
  }
  const eight = elementsFile(8);
  try {
    await assert.rejects(buildVideoRequest({ model: 'video.kling_v4', elementsFile: eight.path }, passthrough), /1-7 Kling 4\.0/);
  } finally {
    eight.cleanup();
  }
});

test('Kling 4 has no audio toggle: --no-audio is not sent there (the API ignores it anyway)', async () => {
  const k4 = await buildVideoRequest({ model: 'video.kling_v4', audio: false }, passthrough);
  assert.equal('generate_audio' in k4, false);
  const other = await buildVideoRequest({ model: 'video.kling_o3', audio: false }, passthrough);
  assert.equal(other.generate_audio, false);
});
