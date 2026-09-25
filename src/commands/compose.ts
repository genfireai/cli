import { Command } from 'commander';
import type { GenFireClient, Run } from '@genfire/sdk';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createClient, publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { dim, printResult } from '../output.js';
import {
  downloadOutputs,
  extractOutputUrls,
  reportRunCompletion,
  resolveMediaInput,
  waitForRun
} from '../runHelpers.js';

// Mirrored from backend/src/routes/publicV1.ts (COMPOSE_ASPECTS /
// COMPOSE_MOTIONS). The API stays the validator of record; these only fail a
// typo before anything is uploaded.
const COMPOSE_ASPECTS = ['16:9', '9:16', '1:1', '4:5', '21:9'] as const;
const COMPOSE_MOTIONS = [
  'none', 'kenburns-in', 'kenburns-out', 'kenburns-pan', 'kenburns-pan-right',
  'kenburns-pan-up', 'kenburns-pan-down', 'kenburns-zoom-tl', 'kenburns-zoom-tr',
  'kenburns-zoom-bl', 'kenburns-zoom-br', 'kenburns-in-eased', 'kenburns-out-eased',
  'handheld-shake'
] as const;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|heic)(\?|$)/i;

/**
 * A `--clip` / `--audio` value: the media first, then `|key=value` modifiers,
 * e.g. `./shot.mp4|trim_in=1|transition=300` or `./still.png|duration=4|motion=kenburns-in`.
 * A bare `|flag` (no `=`) is a boolean true — `|mute`, `|loop`.
 */
export function parseMediaSpec(raw: string, flag: string): { source: string; mods: Record<string, string | true> } {
  const parts = raw.split('|');
  const source = parts[0].trim();
  if (!source) throw new CliError(`${flag} "${raw}" is missing its URL or path.`, 'invalid_compose_spec');
  const mods: Record<string, string | true> = {};
  for (const part of parts.slice(1)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) mods[trimmed.toLowerCase()] = true;
    else mods[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim();
  }
  return { source, mods };
}

function modNumber(mods: Record<string, string | true>, keys: string[], flag: string): number | undefined {
  for (const key of keys) {
    const value = mods[key];
    if (value === undefined) continue;
    const n = Number(value);
    if (value === true || !Number.isFinite(n) || n < 0) {
      throw new CliError(`${flag}: ${key} must be a non-negative number.`, 'invalid_compose_spec');
    }
    return n;
  }
  return undefined;
}

function modBool(mods: Record<string, string | true>, key: string): boolean | undefined {
  const value = mods[key];
  if (value === undefined) return undefined;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new CliError(`${key} must be true or false.`, 'invalid_compose_spec');
}

const CLIP_KEYS = new Set([
  'kind', 'duration', 'trim_in', 'trim_out', 'transition', 'motion', 'intensity',
  'audio', 'audio_mode', 'hold', 'mute'
]);
const TRACK_KEYS = new Set(['start', 'volume', 'loop', 'fade_in', 'fade_out']);

/** One `--clip` spec → a /videos/compose `clips[]` entry (media already resolved). */
export function buildClip(
  spec: { source: string; mods: Record<string, string | true> },
  url: string,
  audioUrl: string | undefined,
  index: number
): Record<string, unknown> {
  const flag = `--clip #${index + 1}`;
  const { mods } = spec;
  for (const key of Object.keys(mods)) {
    if (!CLIP_KEYS.has(key)) {
      throw new CliError(`${flag}: unknown modifier "${key}". Use: ${[...CLIP_KEYS].join(', ')}.`, 'invalid_compose_spec');
    }
  }
  const kindRaw = typeof mods.kind === 'string' ? mods.kind.toLowerCase() : undefined;
  if (kindRaw && kindRaw !== 'image' && kindRaw !== 'video') {
    throw new CliError(`${flag}: kind must be image or video.`, 'invalid_compose_spec');
  }
  const kind = kindRaw ?? (IMAGE_EXTENSIONS.test(spec.source) ? 'image' : 'video');
  const motion = typeof mods.motion === 'string' ? mods.motion : undefined;
  if (motion && !(COMPOSE_MOTIONS as readonly string[]).includes(motion)) {
    throw new CliError(`${flag}: motion must be one of: ${COMPOSE_MOTIONS.join(', ')}.`, 'invalid_compose_spec');
  }
  const intensity = typeof mods.intensity === 'string' ? mods.intensity : undefined;
  if (intensity && !['subtle', 'default', 'punchy'].includes(intensity)) {
    throw new CliError(`${flag}: intensity must be subtle, default or punchy.`, 'invalid_compose_spec');
  }
  const audioMode = typeof mods.audio_mode === 'string' ? mods.audio_mode : undefined;
  if (audioMode && audioMode !== 'replace' && audioMode !== 'mix') {
    throw new CliError(`${flag}: audio_mode must be replace or mix.`, 'invalid_compose_spec');
  }
  const clip: Record<string, unknown> = { url, kind };
  const duration = modNumber(mods, ['duration'], flag);
  const trimIn = modNumber(mods, ['trim_in'], flag);
  const trimOut = modNumber(mods, ['trim_out'], flag);
  const transition = modNumber(mods, ['transition'], flag);
  if (duration !== undefined) clip.duration_sec = duration;
  if (trimIn !== undefined) clip.trim_in_sec = trimIn;
  if (trimOut !== undefined) clip.trim_out_sec = trimOut;
  if (transition !== undefined) clip.transition_ms = transition;
  if (motion) clip.motion = motion;
  if (intensity) clip.motion_intensity = intensity;
  if (audioUrl) clip.audio_url = audioUrl;
  if (audioMode) clip.audio_mode = audioMode;
  const hold = modBool(mods, 'hold');
  if (hold !== undefined) clip.hold_last_frame = hold;
  if (modBool(mods, 'mute')) clip.mute_audio = true;
  return clip;
}

/** One `--audio` spec → a /videos/compose `audio[]` track (media already resolved). */
export function buildTrack(
  spec: { source: string; mods: Record<string, string | true> },
  url: string,
  index: number
): Record<string, unknown> {
  const flag = `--audio #${index + 1}`;
  for (const key of Object.keys(spec.mods)) {
    if (!TRACK_KEYS.has(key)) {
      throw new CliError(`${flag}: unknown modifier "${key}". Use: ${[...TRACK_KEYS].join(', ')}.`, 'invalid_compose_spec');
    }
  }
  const track: Record<string, unknown> = { url };
  const start = modNumber(spec.mods, ['start'], flag);
  const volume = modNumber(spec.mods, ['volume'], flag);
  const fadeIn = modNumber(spec.mods, ['fade_in'], flag);
  const fadeOut = modNumber(spec.mods, ['fade_out'], flag);
  if (volume !== undefined && volume > 1) {
    throw new CliError(`${flag}: volume is 0-1.`, 'invalid_compose_spec');
  }
  if (start !== undefined) track.start_sec = start;
  if (volume !== undefined) track.volume = volume;
  if (modBool(spec.mods, 'loop')) track.loop = true;
  if (fadeIn !== undefined) track.fade_in_sec = fadeIn;
  if (fadeOut !== undefined) track.fade_out_sec = fadeOut;
  return track;
}

/**
 * A media input for compose: an https URL, a local path (uploaded), or a
 * run id (its first output URL). The route takes absolute https URLs only.
 */
export async function resolveComposeMedia(client: GenFireClient, value: string): Promise<string> {
  // Run ids come in more than one prefix (`run_…`, `dash_video_…`), so anything
  // id-shaped that is not a file on disk is treated as a run.
  if (!/^https?:\/\//i.test(value) && /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]+$/.test(value) && !(await isFile(value))) {
    const run: Run = await client.getRun(value);
    if (run.status !== 'completed') {
      throw new CliError(`Run ${value} is ${run.status}; only a completed run can be composed.`, 'run_not_completed');
    }
    const first = extractOutputUrls(run)[0];
    if (!first) throw new CliError(`Run ${value} has no media output.`, 'run_has_no_media');
    return first.url;
  }
  return (await resolveMediaInput(client, value)).url;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readJsonFile(path: string, flag: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new CliError(`Could not read ${flag} ${path}: ${(err as Error).message}`, 'invalid_file');
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`${flag} ${path} is not valid JSON: ${(err as Error).message}`, 'invalid_file');
  }
}

function parseDurationMs(value: string, flag: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) throw new CliError(`Invalid duration for ${flag}: ${value}`, 'invalid_duration');
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms') return Math.max(1, Math.round(amount));
  if (unit === 'm') return Math.round(amount * 60 * 1000);
  return Math.round(amount * 1000);
}

/**
 * The compose twin of generate's maybeFinish: print the queued run, or poll it
 * to a terminal state and download the film.
 */
async function finishRun(
  client: GenFireClient,
  queued: Run,
  opts: { wait: boolean; download: boolean; output?: string; waitTimeout: string; waitInterval: string }
): Promise<void> {
  if (!opts.wait) {
    printResult(queued, () => {
      process.stderr.write(`${dim('Run queued:')} ${queued.id} ${dim(`(${queued.status})`)}\n`);
      process.stderr.write(`${dim('Re-check with:')} genfire runs get ${queued.id}\n`);
    });
    return;
  }
  process.stderr.write(`${dim(`Polling run ${queued.id}...`)}\n`);
  const run = await waitForRun(client, queued.id, {
    intervalMs: parseDurationMs(opts.waitInterval, '--wait-interval'),
    timeoutMs: parseDurationMs(opts.waitTimeout, '--wait-timeout'),
    onTick: (current, elapsed) => {
      if (current.status !== 'completed' && current.status !== 'failed') {
        process.stderr.write(`${dim(`  status=${current.status} elapsed=${Math.round(elapsed / 1000)}s\r`)}`);
      }
    }
  });
  process.stderr.write('\n');
  if (run.status !== 'completed' || !opts.download) {
    reportRunCompletion(run, []);
    return;
  }
  const outputs = extractOutputUrls(run, 'compose');
  const written = outputs.length > 0 ? await downloadOutputs(outputs, opts.output) : [];
  reportRunCompletion(run, written);
}

interface ComposeOptions {
  clip: string[];
  audio: string[];
  spec?: string;
  aspectRatio?: string;
  fit?: string;
  transitionMs?: string;
  clipAudioVolume?: string;
  title?: string;
  captions?: string;
  captionPosition?: string;
  captionAnimation?: string;
  captionWordsPerLine?: string;
  captionText?: string;
  captionTextFile?: string;
  project?: string;
  output?: string;
  download: boolean;
  wait: boolean;
  waitTimeout: string;
  waitInterval: string;
}

/**
 * Flags → the /videos/compose body. `--spec` is the base (a complete body you
 * wrote yourself); `--clip` / `--audio` APPEND to its arrays and scalar flags
 * override its fields. Media must already be resolved to URLs.
 */
export function buildComposeBody(
  opts: ComposeOptions,
  base: Record<string, unknown>,
  clips: Array<Record<string, unknown>>,
  tracks: Array<Record<string, unknown>>,
  captionText?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...base };
  const baseClips = Array.isArray(base.clips) ? (base.clips as unknown[]) : [];
  const baseAudio = Array.isArray(base.audio) ? (base.audio as unknown[]) : [];
  body.clips = [...baseClips, ...clips];
  if (baseAudio.length + tracks.length > 0) body.audio = [...baseAudio, ...tracks];

  if (opts.aspectRatio) {
    if (!(COMPOSE_ASPECTS as readonly string[]).includes(opts.aspectRatio)) {
      throw new CliError(`--aspect-ratio must be one of: ${COMPOSE_ASPECTS.join(', ')}.`, 'invalid_aspect_ratio');
    }
    body.aspect_ratio = opts.aspectRatio;
  }
  if (opts.fit) {
    if (opts.fit !== 'cover' && opts.fit !== 'contain') {
      throw new CliError('--fit must be cover or contain.', 'invalid_fit');
    }
    body.fit = opts.fit;
  }
  const num = (value: string | undefined, flag: string, max?: number): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || (max !== undefined && n > max)) {
      throw new CliError(`${flag} must be a number${max !== undefined ? ` between 0 and ${max}` : ' ≥ 0'}.`, 'invalid_option');
    }
    return n;
  };
  const transition = num(opts.transitionMs, '--transition-ms');
  if (transition !== undefined) body.transition_ms = transition;
  const clipVolume = num(opts.clipAudioVolume, '--clip-audio-volume', 1);
  if (clipVolume !== undefined) body.clip_audio_volume = clipVolume;
  if (opts.title) body.title = opts.title;
  if (opts.project) body.project_id = opts.project;

  if (opts.captions) {
    const existing = (base.captions && typeof base.captions === 'object') ? base.captions as Record<string, unknown> : {};
    const wordsPerLine = num(opts.captionWordsPerLine, '--caption-words-per-line');
    body.captions = {
      ...existing,
      preset_id: opts.captions,
      ...(opts.captionPosition ? { position: opts.captionPosition } : {}),
      ...(opts.captionAnimation ? { animation: opts.captionAnimation } : {}),
      ...(wordsPerLine !== undefined ? { words_per_line: wordsPerLine } : {}),
      ...(captionText ? { text: captionText } : {})
    };
  } else if (opts.captionPosition || opts.captionAnimation || opts.captionWordsPerLine || captionText) {
    throw new CliError('Caption options need --captions <presetId> (see: genfire faceless-reels caption-presets).', 'missing_caption_preset');
  }

  if ((body.clips as unknown[]).length === 0) {
    throw new CliError('Give at least one --clip (or a --spec whose clips array is non-empty).', 'missing_clips');
  }
  if ((body.clips as unknown[]).length > 60) {
    throw new CliError('A compose takes at most 60 clips.', 'too_many_clips');
  }
  if (Array.isArray(body.audio) && body.audio.length > 32) {
    throw new CliError('A compose takes at most 32 audio tracks.', 'too_many_tracks');
  }
  return body;
}

export function registerComposeCommand(program: Command): void {
  const collect = (value: string, previous: string[]) => previous.concat([value]);

  program
    .command('compose')
    .description('Stitch clips and stills into one film with per-scene voiceover, music beds and captions (POST /v1/videos/compose). FREE — the media was billed when it was generated')
    .option(
      '--clip <spec>',
      'A scene, in playback order (repeat). URL, local path (uploaded) or run_ id, then optional |key=value modifiers: ' +
        'kind=image|video (auto from extension), duration=SEC (stills), trim_in=SEC, trim_out=SEC, transition=MS (crossfade in), ' +
        'motion=kenburns-in|… (stills), intensity=subtle|default|punchy, audio=URL|PATH (this scene\'s voiceover), audio_mode=replace|mix, hold=false, mute. ' +
        'e.g. --clip "./still.png|duration=4|motion=kenburns-in|audio=./line1.mp3"',
      collect,
      [] as string[]
    )
    .option(
      '--audio <spec>',
      'A timeline audio track (repeat), e.g. a music bed: URL/path/run_ id then |start=SEC |volume=0-1 |loop |fade_in=SEC |fade_out=SEC. ' +
        'e.g. --audio "./bed.mp3|volume=0.15|loop"',
      collect,
      [] as string[]
    )
    .option('--spec <file>', 'JSON file with a full /videos/compose body. --clip/--audio append to it; other flags override its fields')
    .option('-a, --aspect-ratio <ratio>', `Output framing: ${COMPOSE_ASPECTS.join(', ')} (default 16:9)`)
    .option('--fit <mode>', 'cover (crop to fill, default) or contain (letterbox)')
    .option('--transition-ms <ms>', 'Default crossfade between clips that name none; 0 = hard cuts')
    .option('--clip-audio-volume <0-1>', "Duck every clip's own audio to this level (0 silences them)")
    .option('--title <title>', 'Title for the finished film')
    .option('--captions <presetId>', 'Burn in captions with this preset (see: genfire faceless-reels caption-presets)')
    .option('--caption-position <pos>', 'top | middle | bottom')
    .option('--caption-animation <name>', 'highlight | pop | typewriter | classic | background')
    .option('--caption-words-per-line <n>', 'Words per caption line')
    .option('--caption-text <text>', 'Authored transcript to caption (instead of auto-transcribing the audio)')
    .option('--caption-text-file <path>', 'Read the authored transcript from a text file')
    .option('--project <projectId>', 'File the film into this project when it completes')
    .option('-o, --output <path>', 'Where to save the film. File path or directory; defaults to cwd')
    .option('--no-download', "Don't download the film; only print the URL")
    .option('--no-wait', "Don't wait for the render; print the queued run and exit")
    .option('--wait-timeout <duration>', 'Maximum time to wait, e.g. 20m, 600s', '20m')
    .option('--wait-interval <duration>', 'Polling interval while waiting', '3s')
    .action(async (opts: ComposeOptions) => {
      if (opts.captionText && opts.captionTextFile) {
        throw new CliError('--caption-text and --caption-text-file cannot be used together.', 'invalid_arguments');
      }
      const base = opts.spec ? await readJsonFile(opts.spec, '--spec') : {};
      if (!base || typeof base !== 'object' || Array.isArray(base)) {
        throw new CliError('--spec must contain a JSON object (the compose body).', 'invalid_file');
      }
      let captionText = opts.captionText;
      if (opts.captionTextFile) {
        try {
          captionText = await readFile(opts.captionTextFile, 'utf8');
        } catch (err) {
          throw new CliError(`Could not read --caption-text-file: ${(err as Error).message}`, 'invalid_file');
        }
      }

      // Parse every spec BEFORE uploading anything, so a typo costs nothing.
      const clipSpecs = opts.clip.map((raw) => parseMediaSpec(raw, '--clip'));
      const trackSpecs = opts.audio.map((raw) => parseMediaSpec(raw, '--audio'));
      clipSpecs.forEach((spec, i) => buildClip(spec, 'https://placeholder.invalid', undefined, i));
      trackSpecs.forEach((spec, i) => buildTrack(spec, 'https://placeholder.invalid', i));
      buildComposeBody(
        opts,
        base as Record<string, unknown>,
        clipSpecs.map(() => ({})),
        [],
        captionText
      );

      const client = await createClient();
      const clips: Array<Record<string, unknown>> = [];
      for (const [i, spec] of clipSpecs.entries()) {
        const url = await resolveComposeMedia(client, spec.source);
        const audio = typeof spec.mods.audio === 'string' ? await resolveComposeMedia(client, spec.mods.audio) : undefined;
        clips.push(buildClip(spec, url, audio, i));
      }
      const tracks: Array<Record<string, unknown>> = [];
      for (const [i, spec] of trackSpecs.entries()) {
        tracks.push(buildTrack(spec, await resolveComposeMedia(client, spec.source), i));
      }

      const body = buildComposeBody(opts, base as Record<string, unknown>, clips, tracks, captionText);
      const queued = await publicApiRequest<Run>('POST', '/videos/compose', {
        body,
        idempotencyKey: randomUUID()
      });
      await finishRun(client, queued, opts);
    });
}
