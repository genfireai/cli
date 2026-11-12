import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { buildVocalCreateBody, parseStemVariation, registerMusicVocalsCommands } from './musicVocals.js';
import { buildMusicExtraFields } from '../generationRequests.js';
import { CliError } from '../errors.js';

// Vocal training and stem separation are billed; `generate music` carries the
// 2026-11 ElevenLabs fields. These pin the wire shapes so a flag rename cannot
// silently drop a field, and check that typos fail before anything uploads.

const tracks = (n: number) => Array.from({ length: n }, (_, i) => `https://cdn.example.test/${i}.mp3`);

test('vocal create body: snake_case wire fields, kind and tags optional', () => {
  assert.deepEqual(
    buildVocalCreateBody('  My Studio Voice ', tracks(2), { genre: 'pop', kind: 'Style', tag: ['warm'], team: 'team_1', quote: 'q_1' }),
    { name: 'My Studio Voice', primary_genre: 'pop', track_urls: tracks(2), kind: 'style', tags: ['warm'], team_id: 'team_1', quote_token: 'q_1' }
  );
  assert.deepEqual(
    buildVocalCreateBody('My Studio Voice', tracks(1), { genre: 'hip hop' }),
    { name: 'My Studio Voice', primary_genre: 'hip hop', track_urls: tracks(1) }
  );
});

test('vocal create body: name length, genre, track count and kind fail locally', () => {
  assert.throws(() => buildVocalCreateBody('abc', tracks(1), { genre: 'pop' }), CliError);
  assert.throws(() => buildVocalCreateBody('Long enough', tracks(1), { genre: ' ' }), CliError);
  assert.throws(() => buildVocalCreateBody('Long enough', [], { genre: 'pop' }), CliError);
  assert.throws(() => buildVocalCreateBody('Long enough', tracks(51), { genre: 'pop' }), CliError);
  assert.throws(() => buildVocalCreateBody('Long enough', tracks(1), { genre: 'pop', kind: 'singer' }), CliError);
});

test('stem variation shorthands', () => {
  assert.equal(parseStemVariation(undefined), undefined);
  assert.equal(parseStemVariation('two'), 'two_stems_v1');
  assert.equal(parseStemVariation('6'), 'six_stems_v1');
  assert.equal(parseStemVariation('SIX_STEMS_V1'), 'six_stems_v1');
  assert.throws(() => parseStemVariation('four'), CliError);
});

test('music extras: every flag maps to its wire field', () => {
  assert.deepEqual(
    buildMusicExtraFields({
      vocal: 'ft_abc', vocalStrength: '1.4', generationMode: 'LOOP', phoneticNames: true, waveform: true,
      referenceAudio: 'ref.mp3', referenceStartMs: '15000', conditionStrength: 'xhigh',
    }, { hasVideo: false }),
    {
      finetune_id: 'ft_abc', finetune_strength: 1.4, generation_mode: 'loop', use_phonetic_names: true, with_waveform: true,
      reference_start_ms: 15000, condition_strength: 'xhigh',
    }
  );
  assert.deepEqual(
    buildMusicExtraFields({ addSfx: true, separateTracks: true, useAudioAsReference: true }, { hasVideo: true }),
    { add_sfx: true, separate_tracks: true, use_audio_as_reference: true }
  );
  assert.deepEqual(buildMusicExtraFields({}, { hasVideo: false }), {});
});

test('music extras: misplaced or misspelled flags fail before any upload', () => {
  assert.throws(() => buildMusicExtraFields({ generationMode: 'jingle' }, { hasVideo: false }), CliError);
  assert.throws(() => buildMusicExtraFields({ vocalStrength: '1' }, { hasVideo: false }), CliError);
  assert.throws(() => buildMusicExtraFields({ conditionStrength: 'high' }, { hasVideo: false }), CliError);
  assert.throws(() => buildMusicExtraFields({ referenceAudio: 'a.mp3', conditionStrength: 'max' }, { hasVideo: false }), CliError);
  assert.throws(() => buildMusicExtraFields({ referenceAudio: 'a.mp3', referenceStartMs: '-5' }, { hasVideo: false }), CliError);
  assert.throws(() => buildMusicExtraFields({ referenceAudio: 'a.mp3' }, { hasVideo: true }), CliError);
  assert.throws(() => buildMusicExtraFields({ addSfx: true }, { hasVideo: false }), CliError);
});

test('vocals and stems register their subcommands', () => {
  const program = new Command();
  registerMusicVocalsCommands(program);
  const vocals = program.commands.find((c) => c.name() === 'vocals');
  const stems = program.commands.find((c) => c.name() === 'stems');
  assert.deepEqual(vocals?.commands.map((c) => c.name()).sort(), ['create', 'delete', 'estimate', 'get', 'list']);
  assert.deepEqual(stems?.commands.map((c) => c.name()).sort(), ['estimate', 'split']);
});
