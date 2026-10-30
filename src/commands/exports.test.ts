import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { normalizeExportFormat, parseInterchangeFormats, registerRunLifecycleCommands } from './exports.js';

test('pro export formats accept the obvious spellings and nothing else', () => {
  assert.equal(normalizeExportFormat('prores'), 'prores_422_hq');
  assert.equal(normalizeExportFormat('ProRes-422-HQ'), 'prores_422_hq');
  assert.equal(normalizeExportFormat('dnxhr'), 'dnxhr_hq');
  assert.equal(normalizeExportFormat('tif'), 'tiff_sequence');
  assert.equal(normalizeExportFormat('psd'), 'psd');
  assert.equal(normalizeExportFormat('gif'), null);
});

test('interchange --formats maps aliases and drops unknown names', () => {
  assert.deepEqual(parseInterchangeFormats('premiere, fcp ,otio,bogus,xmeml'), ['xmeml', 'fcpxml', 'otio']);
  assert.deepEqual(parseInterchangeFormats(undefined), []);
});

test('attaches to existing runs/timeline groups instead of duplicating them', () => {
  const program = new Command();
  program.command('runs');
  program.command('timeline');
  registerRunLifecycleCommands(program);
  assert.equal(program.commands.filter((c) => c.name() === 'runs').length, 1);
  const runs = program.commands.find((c) => c.name() === 'runs')!;
  assert.deepEqual(runs.commands.map((c) => c.name()).sort(), ['cancel', 'delete']);
  const timeline = program.commands.find((c) => c.name() === 'timeline')!;
  assert.deepEqual(timeline.commands.map((c) => c.name()), ['export']);
  assert.ok(program.commands.some((c) => c.name() === 'export'));
});
