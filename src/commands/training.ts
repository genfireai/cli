import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createClient, publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, red, yellow } from '../output.js';
import { resolveMediaInput } from '../runHelpers.js';

/**
 * Trained styles and trained models — the three training surfaces of /v1:
 *
 *   image-styles    /v1/image-styles   Flux / Z-Image Turbo image adapters (5–60 images)
 *   trained-models  /v1/loras          Hailuo 03 video LoRAs (clips or a dataset zip)
 *   style-skills    /v1/style-skills   moodboard + skill from 3–40 images, optional adapter
 *
 * Installed @genfire/sdk (0.23.0) has none of these, so every call goes through
 * `publicApiRequest`. The POST routes sit behind `requireIdempotencyKey` (the
 * billable submit runs under a request id derived from it), so each submit
 * sends a fresh `Idempotency-Key`.
 *
 * Limits below mirror the backend (lib/models/fluxLoraEndpoints.ts,
 * types/videoLora.ts, services/agent/tools/styleSkillTools.ts) so a typo fails
 * before anything uploads; the API stays the validator of record.
 */

const IMAGE_STYLE_MIN_IMAGES = 5;
const IMAGE_STYLE_MAX_IMAGES = 60;
const IMAGE_STYLE_MIN_STEPS = 100;
const IMAGE_STYLE_MAX_STEPS = 4000;
const IMAGE_STYLE_BASES = ['flux', 'z_image_turbo'] as const;
const IMAGE_STYLE_KINDS = ['style', 'subject'] as const;
const IMAGE_STYLE_STATUSES = ['queued', 'training', 'completed', 'failed'] as const;

const STYLE_SKILL_MIN_IMAGES = 3;
const STYLE_SKILL_MAX_IMAGES = 40;

const LORA_KINDS = ['style', 'subject', 'keyframe', 't2v'] as const;
const LORA_STATUSES = ['pending', 'training', 'completed', 'failed'] as const;
const LORA_MIN_STEPS = 100;
const LORA_MAX_STEPS = 6000;
const LORA_MAX_CLIPS = 40;
const LORA_RANKS = [8, 16, 32, 64, 128] as const;
const LORA_TRAIN_RESOLUTIONS = ['low', 'medium', 'high'] as const;
const LORA_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
const LORA_FRAME_COUNTS = [22, 39, 56, 73, 90, 107, 124] as const;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv']);

const collect = (value: string, previous: string[]) => previous.concat([value]);

function statusColor(status: string): string {
  if (status === 'completed') return green(status);
  if (status === 'failed') return red(status);
  return yellow(status);
}

function parseIntInRange(value: string | undefined, flag: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CliError(`${flag} must be an integer between ${min} and ${max}.`, 'invalid_option');
  }
  return n;
}

function parseOneOf<T extends string | number>(value: string | undefined, flag: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  const match = allowed.find((entry) => String(entry) === value.trim());
  if (match === undefined) {
    throw new CliError(`${flag} must be one of: ${allowed.join(', ')}.`, 'invalid_option');
  }
  return match;
}

function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new CliError('--limit must be an integer 1-50', 'invalid_limit');
  }
  return n;
}

/**
 * Expand each input: a URL passes through, a file stays a file, and a
 * DIRECTORY becomes its media files (sorted, non-recursive) — a training set is
 * usually a folder, and typing 40 `-i` flags is not a workflow.
 */
export async function expandMediaInputs(inputs: string[], extensions: Set<string>): Promise<string[]> {
  const out: string[] = [];
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) {
      out.push(input);
      continue;
    }
    let isDir = false;
    try {
      isDir = (await stat(input)).isDirectory();
    } catch {
      // Not a directory we can read — resolveMediaInput reports the real error.
    }
    if (!isDir) {
      out.push(input);
      continue;
    }
    const entries = (await readdir(input, { withFileTypes: true }))
      .filter((e) => e.isFile() && extensions.has(extname(e.name).toLowerCase()))
      .map((e) => join(input, e.name))
      .sort();
    if (entries.length === 0) {
      throw new CliError(`Directory ${input} contains no ${[...extensions].join('/')} files.`, 'invalid_media_input');
    }
    out.push(...entries);
  }
  return out;
}

async function uploadAll(inputs: string[]): Promise<string[]> {
  if (inputs.every((input) => /^https?:\/\//i.test(input))) return inputs;
  const client = await createClient();
  const urls: string[] = [];
  for (const input of inputs) {
    urls.push((await resolveMediaInput(client, input)).url);
  }
  return urls;
}

function printEstimate(estimate: any): void {
  printResult(estimate, () => {
    process.stdout.write(`${bold(String(estimate.model ?? ''))}  ${dim(String(estimate.capability ?? ''))}\n`);
    process.stdout.write(`${dim('Cost:')}     ${cyan(String(estimate.credits))} credits\n`);
    for (const [key, value] of Object.entries((estimate.breakdown ?? {}) as Record<string, unknown>)) {
      process.stdout.write(`${dim(`  ${key}:`)} ${String(value)}\n`);
    }
    if (estimate.quote_token) {
      process.stdout.write(
        `${dim('Quote:')}    ${estimate.quote_token}${estimate.expires_at ? dim(` (expires ${estimate.expires_at})`) : ''}\n`
      );
    }
  });
}

// ─── image-styles ────────────────────────────────────────────────────────────

export interface ImageStyleTrainFlags {
  kind?: string;
  trigger?: string;
  steps?: string;
  base?: string;
  skill?: string;
  team?: string;
}

/** The POST /v1/image-styles body. Pure, so the wire shape is testable. */
export function buildImageStyleTrainBody(name: string, imageUrls: string[], flags: ImageStyleTrainFlags): Record<string, unknown> {
  if (imageUrls.length < IMAGE_STYLE_MIN_IMAGES || imageUrls.length > IMAGE_STYLE_MAX_IMAGES) {
    throw new CliError(
      `An image style trains on ${IMAGE_STYLE_MIN_IMAGES}–${IMAGE_STYLE_MAX_IMAGES} images (got ${imageUrls.length}).`,
      'invalid_image_count'
    );
  }
  const kind = parseOneOf(flags.kind, '--kind', IMAGE_STYLE_KINDS);
  const baseModel = parseOneOf(flags.base, '--base', IMAGE_STYLE_BASES);
  const steps = parseIntInRange(flags.steps, '--steps', IMAGE_STYLE_MIN_STEPS, IMAGE_STYLE_MAX_STEPS);
  return {
    name,
    image_urls: imageUrls,
    ...(kind ? { kind } : {}),
    ...(baseModel ? { base_model: baseModel } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(flags.trigger ? { trigger_word: flags.trigger } : {}),
    ...(flags.skill ? { skill_id: flags.skill } : {}),
    ...(flags.team ? { team_id: flags.team } : {})
  };
}

function registerImageStyles(program: Command): void {
  const styles = program
    .command('image-styles')
    .description('Train and manage image styles (Flux / Z-Image Turbo adapters) — use with generate image -m image.flux_lora');

  styles
    .command('list')
    .description('List your image styles (and ones shared with your workspaces)')
    .option('-s, --status <status>', `Filter by status: ${IMAGE_STYLE_STATUSES.join(', ')}`)
    .option('-l, --limit <n>', 'Max styles to return (1-50)', '50')
    .action(async (opts: { status?: string; limit: string }) => {
      parseOneOf(opts.status, '--status', IMAGE_STYLE_STATUSES);
      const query = new URLSearchParams({ limit: String(parseLimit(opts.limit)) });
      if (opts.status) query.set('status', opts.status);
      const response = await publicApiRequest<{ object: 'list'; data: any[] }>('GET', `/image-styles?${query}`);
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No image styles yet.')}\n`);
          process.stdout.write(`${dim('Train one: genfire image-styles train "Ink Wash" -i ./refs/')}\n`);
          return;
        }
        printTable(
          response.data.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            status: statusColor(String(s.status)),
            model: s.model,
            images: s.image_count,
            created: String(s.created_at ?? '').replace('T', ' ').slice(0, 19)
          })),
          ['id', 'name', 'kind', 'status', 'model', 'images', 'created']
        );
      });
    });

  styles
    .command('get <styleId>')
    .description('Show one image style')
    .action(async (styleId: string) => {
      const s = await publicApiRequest<any>('GET', `/image-styles/${encodeURIComponent(styleId)}`);
      printResult(s, () => {
        process.stdout.write(`${bold(s.name)}  ${dim(s.id)}\n`);
        process.stdout.write(`${dim('Status:')}  ${statusColor(String(s.status))}\n`);
        process.stdout.write(`${dim('Kind:')}    ${s.kind}\n`);
        process.stdout.write(`${dim('Model:')}   ${s.model} ${dim(`(base ${s.base_model})`)}\n`);
        if (s.trigger_word) process.stdout.write(`${dim('Trigger:')} ${s.trigger_word}\n`);
        process.stdout.write(`${dim('Images:')}  ${s.image_count}  ${dim('Steps:')} ${s.steps ?? ''}\n`);
        if (s.credits_charged != null) process.stdout.write(`${dim('Charged:')} ${s.credits_charged} credits\n`);
        if (s.error) process.stdout.write(`${red('Error:')}   ${typeof s.error === 'string' ? s.error : JSON.stringify(s.error)}\n`);
        if (s.status === 'completed') {
          process.stdout.write(`\n${dim(`Use it: generate on ${s.model} with loras: [{ "id": "${s.id}" }]`)}\n`);
        }
      });
    });

  styles
    .command('estimate')
    .description('Quote the credit cost of training an image style. Free.')
    .requiredOption('-n, --image-count <n>', `How many training images (${IMAGE_STYLE_MIN_IMAGES}-${IMAGE_STYLE_MAX_IMAGES})`)
    .option('--steps <n>', `Training steps (${IMAGE_STYLE_MIN_STEPS}-${IMAGE_STYLE_MAX_STEPS})`)
    .option('--base <model>', `Base model: ${IMAGE_STYLE_BASES.join(' | ')} (default flux)`)
    .action(async (opts: { imageCount: string; steps?: string; base?: string }) => {
      const imageCount = parseIntInRange(opts.imageCount, '--image-count', IMAGE_STYLE_MIN_IMAGES, IMAGE_STYLE_MAX_IMAGES);
      const steps = parseIntInRange(opts.steps, '--steps', IMAGE_STYLE_MIN_STEPS, IMAGE_STYLE_MAX_STEPS);
      const baseModel = parseOneOf(opts.base, '--base', IMAGE_STYLE_BASES);
      printEstimate(await publicApiRequest('POST', '/image-styles/estimate-cost', {
        body: { image_count: imageCount, ...(steps !== undefined ? { steps } : {}), ...(baseModel ? { base_model: baseModel } : {}) }
      }));
    });

  styles
    .command('train <name>')
    .description(`Train an image style from ${IMAGE_STYLE_MIN_IMAGES}-${IMAGE_STYLE_MAX_IMAGES} images. BILLED — quote it first with \`genfire image-styles estimate\``)
    .requiredOption('-i, --image <urlOrPath>', 'Training image URL, local file, or a directory of images (repeatable; local files are uploaded)', collect, [] as string[])
    .option('--kind <kind>', `${IMAGE_STYLE_KINDS.join(' | ')} (default style)`)
    .option('--trigger <word>', 'Trigger word to cite in prompts')
    .option('--steps <n>', `Training steps (${IMAGE_STYLE_MIN_STEPS}-${IMAGE_STYLE_MAX_STEPS})`)
    .option('--base <model>', `Base model: ${IMAGE_STYLE_BASES.join(' | ')} (default flux)`)
    .option('--skill <skillId>', 'Attach the trained style to this style skill')
    .option('--team <teamId>', 'Bill the training to a workspace credit pool instead of your own balance')
    .action(async (name: string, opts: ImageStyleTrainFlags & { image: string[] }) => {
      const inputs = await expandMediaInputs(opts.image, IMAGE_EXTENSIONS);
      // Validate everything that can fail locally BEFORE uploading.
      buildImageStyleTrainBody(name, inputs, opts);
      const body = buildImageStyleTrainBody(name, await uploadAll(inputs), opts);
      const s = await publicApiRequest<any>('POST', '/image-styles', { body, idempotencyKey: randomUUID() });
      printResult(s, () => {
        process.stdout.write(`${green('✓')} Training ${bold(s.name)}  ${dim(s.id)} ${dim(`(${s.status})`)}\n`);
        process.stdout.write(`${dim('Check on it:')} genfire image-styles get ${s.id}\n`);
      });
    });

  styles
    .command('delete <styleId>')
    .description('Delete an image style you own')
    .action(async (styleId: string) => {
      const result = await publicApiRequest<any>('DELETE', `/image-styles/${encodeURIComponent(styleId)}`);
      printResult(result, () => {
        process.stdout.write(`${green('✓')} Deleted image style ${styleId}\n`);
      });
    });
}

// ─── trained-models (/v1/loras) ──────────────────────────────────────────────

export interface LoraTrainFlags {
  kind: string;
  trigger?: string;
  steps?: string;
  rank?: string;
  learningRate?: string;
  trainResolution?: string;
  aspectRatio?: string;
  frameCount?: string;
  frameRate?: string;
  splitScenes?: boolean;
  strictDataset?: boolean;
  resumeFrom?: string;
  influencer?: string;
  datasetZip?: string;
  caption?: string[];
  rightsAttested?: boolean;
  team?: string;
  quote?: string;
}

/**
 * `--caption N:TEXT` (0-based clip index) → per-clip captions. A clip with a
 * caption goes on the wire as `{ url, caption }`; the rest as a bare URL
 * (`clips` accepts both shapes).
 */
function buildClips(clipUrls: string[], captions: string[] = []): Array<string | { url: string; caption: string }> {
  const byIndex = new Map<number, string>();
  for (const spec of captions) {
    const m = /^(\d+):([\s\S]+)$/.exec(spec);
    if (!m) throw new CliError(`--caption "${spec}" must look like N:TEXT (0-based clip index).`, 'invalid_caption');
    const index = Number(m[1]);
    if (index >= clipUrls.length) throw new CliError(`--caption ${spec}: there is no clip #${index} (0-based).`, 'invalid_caption');
    byIndex.set(index, m[2].trim());
  }
  return clipUrls.map((url, i) => (byIndex.has(i) ? { url, caption: byIndex.get(i)! } : url));
}

/** The POST /v1/loras body. Pure, so the wire shape is testable. */
export function buildLoraTrainBody(name: string, clipUrls: string[], flags: LoraTrainFlags): Record<string, unknown> {
  const kind = parseOneOf(flags.kind, '--kind', LORA_KINDS);
  if (!flags.rightsAttested) {
    throw new CliError(
      'Pass --rights-attested to confirm you hold the rights to every clip in the training set.',
      'rights_not_attested'
    );
  }
  if (clipUrls.length > 0 && flags.datasetZip) {
    throw new CliError('Pass either --clip or --dataset-zip, not both.', 'invalid_clips');
  }
  if (clipUrls.length === 0 && !flags.datasetZip) {
    throw new CliError('Provide the training clips with --clip (repeatable) or a --dataset-zip URL.', 'invalid_clips');
  }
  if (clipUrls.length > LORA_MAX_CLIPS) {
    throw new CliError(`At most ${LORA_MAX_CLIPS} clips per training run — use --dataset-zip for larger sets.`, 'too_many_clips');
  }
  if (flags.resumeFrom && kind !== 'subject') {
    throw new CliError('--resume-from applies to subject models only.', 'resume_not_supported');
  }
  const steps = parseIntInRange(flags.steps, '--steps', LORA_MIN_STEPS, LORA_MAX_STEPS);
  const rank = parseOneOf(flags.rank, '--rank', LORA_RANKS);
  const trainResolution = parseOneOf(flags.trainResolution, '--train-resolution', LORA_TRAIN_RESOLUTIONS);
  const aspectRatio = parseOneOf(flags.aspectRatio, '--aspect-ratio', LORA_ASPECT_RATIOS);
  const frameCount = parseOneOf(flags.frameCount, '--frame-count', LORA_FRAME_COUNTS);
  const frameRate = parseIntInRange(flags.frameRate, '--frame-rate', 8, 60);
  let learningRate: number | undefined;
  if (flags.learningRate !== undefined) {
    learningRate = Number(flags.learningRate);
    if (!Number.isFinite(learningRate) || learningRate < 0.000001 || learningRate > 1) {
      throw new CliError('--learning-rate must be between 0.000001 and 1.', 'invalid_option');
    }
  }
  return {
    name,
    kind,
    rights_attested: true,
    ...(clipUrls.length > 0 ? { clips: buildClips(clipUrls, flags.caption) } : {}),
    ...(flags.datasetZip ? { dataset_zip_url: flags.datasetZip } : {}),
    ...(flags.trigger ? { trigger_phrase: flags.trigger } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(rank !== undefined ? { rank } : {}),
    ...(learningRate !== undefined ? { learning_rate: learningRate } : {}),
    ...(trainResolution ? { train_resolution: trainResolution } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(frameCount !== undefined ? { frame_count: frameCount } : {}),
    ...(frameRate !== undefined ? { frame_rate: frameRate } : {}),
    ...(flags.splitScenes !== undefined ? { split_scenes: flags.splitScenes } : {}),
    ...(flags.strictDataset ? { strict_dataset: true } : {}),
    ...(flags.resumeFrom ? { resume_from_lora_id: flags.resumeFrom } : {}),
    ...(flags.influencer ? { influencer_id: flags.influencer } : {}),
    ...(flags.team ? { team_id: flags.team } : {}),
    ...(flags.quote ? { quote_token: flags.quote } : {})
  };
}

function printLoraRun(result: any): void {
  printResult(result, () => {
    const lora = result.lora;
    process.stdout.write(`${green('✓')} Training run ${bold(result.id)} ${dim(`(${result.status})`)}\n`);
    if (lora) {
      process.stdout.write(`${dim('Model:')}       ${lora.name} ${dim(lora.id)} ${dim(`(${lora.kind}, ${lora.status})`)}\n`);
      process.stdout.write(`${dim('Check on it:')} genfire trained-models get ${lora.id}\n`);
    } else {
      process.stdout.write(`${dim('Check on it:')} genfire runs get ${result.id}\n`);
    }
  });
}

function registerTrainedModels(program: Command): void {
  const models = program
    .command('trained-models')
    .description('Train and manage video models (Hailuo 03 LoRAs) — use with generate video -m video.hailuo_03');

  models
    .command('list')
    .description('List your trained video models')
    .option('-s, --status <status>', `Filter by status: ${LORA_STATUSES.join(', ')}`)
    .option('-l, --limit <n>', 'Max models to return (1-50)', '50')
    .action(async (opts: { status?: string; limit: string }) => {
      parseOneOf(opts.status, '--status', LORA_STATUSES);
      const query = new URLSearchParams({ limit: String(parseLimit(opts.limit)) });
      if (opts.status) query.set('status', opts.status);
      const response = await publicApiRequest<{ object: 'list'; data: any[] }>('GET', `/loras?${query}`);
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No trained models yet.')}\n`);
          process.stdout.write(`${dim('Train one: genfire trained-models train "My Look" --kind style --clip ./clips/ --rights-attested')}\n`);
          return;
        }
        printTable(
          response.data.map((m) => ({
            id: m.id,
            name: m.name,
            kind: m.kind,
            status: statusColor(String(m.status)),
            clips: m.clip_count,
            steps: m.steps ?? '',
            created: String(m.created_at ?? '').replace('T', ' ').slice(0, 19)
          })),
          ['id', 'name', 'kind', 'status', 'clips', 'steps', 'created']
        );
      });
    });

  models
    .command('get <loraId>')
    .description('Show one trained video model')
    .action(async (loraId: string) => {
      const m = await publicApiRequest<any>('GET', `/loras/${encodeURIComponent(loraId)}`);
      printResult(m, () => {
        process.stdout.write(`${bold(m.name)}  ${dim(m.id)}\n`);
        process.stdout.write(`${dim('Status:')}    ${statusColor(String(m.status))}\n`);
        process.stdout.write(`${dim('Kind:')}      ${m.kind} ${dim(`(inference: ${m.inference_mode})`)}\n`);
        process.stdout.write(`${dim('Model:')}     ${m.model}\n`);
        if (m.trigger_phrase) process.stdout.write(`${dim('Trigger:')}   ${m.trigger_phrase}\n`);
        process.stdout.write(`${dim('Clips:')}     ${m.clip_count}  ${dim('Steps:')} ${m.steps ?? ''}  ${dim('Rank:')} ${m.rank ?? ''}\n`);
        if (m.credits_charged != null) process.stdout.write(`${dim('Charged:')}   ${m.credits_charged} credits\n`);
        if (m.sample_video_url) process.stdout.write(`${dim('Sample:')}    ${cyan(m.sample_video_url)}\n`);
        if (m.error) process.stdout.write(`${red('Error:')}     ${typeof m.error === 'string' ? m.error : JSON.stringify(m.error)}\n`);
      });
    });

  models
    .command('estimate')
    .description('Quote the credit cost of training a video model. Free — returns a quote_token for `train --quote`')
    .requiredOption('--kind <kind>', LORA_KINDS.join(' | '))
    .option('--steps <n>', `Training steps (${LORA_MIN_STEPS}-${LORA_MAX_STEPS})`)
    .action(async (opts: { kind: string; steps?: string }) => {
      const kind = parseOneOf(opts.kind, '--kind', LORA_KINDS);
      const steps = parseIntInRange(opts.steps, '--steps', LORA_MIN_STEPS, LORA_MAX_STEPS);
      printEstimate(await publicApiRequest('POST', '/loras/estimate-cost', {
        body: { kind, ...(steps !== undefined ? { steps } : {}) }
      }));
    });

  models
    .command('train <name>')
    .description('Train a video model from clips or a dataset zip. BILLED — quote it first with `genfire trained-models estimate`')
    .requiredOption('--kind <kind>', `${LORA_KINDS.join(' | ')}`)
    .option('--clip <urlOrPath>', `Training clip URL, local file, or a directory of clips (repeatable, up to ${LORA_MAX_CLIPS}; local files are uploaded)`, collect, [] as string[])
    .option('--caption <N:text>', 'Caption for clip N (0-based), e.g. --caption "0:a woman turns to camera" (repeatable)', collect, [] as string[])
    .option('--dataset-zip <url>', 'URL of a .zip dataset instead of --clip (for larger sets)')
    .option('--rights-attested', 'Confirm you hold the rights to every clip (required)')
    .option('--trigger <phrase>', 'Trigger phrase to cite in prompts')
    .option('--steps <n>', `Training steps (${LORA_MIN_STEPS}-${LORA_MAX_STEPS})`)
    .option('--rank <n>', `LoRA rank: ${LORA_RANKS.join(', ')}`)
    .option('--learning-rate <n>', 'Learning rate (0.000001-1)')
    .option('--train-resolution <res>', LORA_TRAIN_RESOLUTIONS.join(' | '))
    .option('--aspect-ratio <ratio>', LORA_ASPECT_RATIOS.join(' | '))
    .option('--frame-count <n>', `Frames per sample: ${LORA_FRAME_COUNTS.join(', ')}`)
    .option('--frame-rate <fps>', 'Sampling frame rate (8-60)')
    .option('--split-scenes', 'Split clips at scene cuts before training')
    .option('--no-split-scenes', 'Never split clips at scene cuts')
    .option('--strict-dataset', 'Fail instead of skipping clips that do not fit the dataset rules')
    .option('--resume-from <loraId>', 'Subject only: warm-start from an earlier trained model')
    .option('--influencer <id>', 'Link the trained model to this influencer')
    .option('--team <teamId>', 'Bill the training to a workspace credit pool instead of your own balance')
    .option('--quote <token>', 'A quote_token from `genfire trained-models estimate` — charges the price you were quoted')
    .action(async (name: string, opts: LoraTrainFlags & { clip: string[] }) => {
      const inputs = await expandMediaInputs(opts.clip, VIDEO_EXTENSIONS);
      buildLoraTrainBody(name, inputs, opts);
      const body = buildLoraTrainBody(name, await uploadAll(inputs), opts);
      printLoraRun(await publicApiRequest<any>('POST', '/loras', { body, idempotencyKey: randomUUID() }));
    });

  models
    .command('continue <loraId>')
    .description('Continue training a completed SUBJECT model with more steps (optionally more clips). BILLED')
    .option('--steps <n>', `Additional training steps (${LORA_MIN_STEPS}-${LORA_MAX_STEPS})`)
    .option('--name <name>', 'Name for the continued model')
    .option('--clip <urlOrPath>', 'Extra training clip URL, local file or directory (repeatable)', collect, [] as string[])
    .option('--rights-attested', 'Confirm you hold the rights to any new clips')
    .option('--team <teamId>', 'Bill the training to a workspace credit pool instead of your own balance')
    .action(async (loraId: string, opts: { steps?: string; name?: string; clip: string[]; rightsAttested?: boolean; team?: string }) => {
      const steps = parseIntInRange(opts.steps, '--steps', LORA_MIN_STEPS, LORA_MAX_STEPS);
      const inputs = await expandMediaInputs(opts.clip, VIDEO_EXTENSIONS);
      if (inputs.length > LORA_MAX_CLIPS) {
        throw new CliError(`At most ${LORA_MAX_CLIPS} clips per training run.`, 'too_many_clips');
      }
      if (inputs.length > 0 && !opts.rightsAttested) {
        throw new CliError('Pass --rights-attested to confirm you hold the rights to the new clips.', 'rights_not_attested');
      }
      const clips = await uploadAll(inputs);
      const body = {
        ...(steps !== undefined ? { steps } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        ...(clips.length > 0 ? { clips } : {}),
        ...(opts.rightsAttested ? { rights_attested: true } : {}),
        ...(opts.team ? { team_id: opts.team } : {})
      };
      printLoraRun(await publicApiRequest<any>('POST', `/loras/${encodeURIComponent(loraId)}/continue`, {
        body,
        idempotencyKey: randomUUID()
      }));
    });

  models
    .command('delete <loraId>')
    .description('Delete a trained video model you own')
    .action(async (loraId: string) => {
      const result = await publicApiRequest<any>('DELETE', `/loras/${encodeURIComponent(loraId)}`);
      printResult(result, () => {
        process.stdout.write(`${green('✓')} Deleted trained model ${loraId}\n`);
      });
    });
}

// ─── style-skills ────────────────────────────────────────────────────────────

function registerStyleSkills(program: Command): void {
  const skills = program
    .command('style-skills')
    .description('Style skills — a moodboard + skill built from reference images, optionally with a trained image style');

  skills
    .command('list')
    .description('List your style skills')
    .action(async () => {
      const response = await publicApiRequest<{ object: 'list'; data: any[] }>('GET', '/style-skills');
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No style skills yet.')}\n`);
          process.stdout.write(`${dim('Create one: genfire style-skills create "Riso Print" -i ./refs/')}\n`);
          return;
        }
        printTable(
          response.data.map((s) => ({
            id: s.id,
            title: s.title,
            images: s.image_count,
            moodboard: s.moodboard_id ?? '',
            style: s.lora_id ? `${s.lora_id} (${s.lora_status})` : ''
          })),
          ['id', 'title', 'images', 'moodboard', 'style']
        );
      });
    });

  skills
    .command('create <name>')
    .description(`Create a style skill from ${STYLE_SKILL_MIN_IMAGES}-${STYLE_SKILL_MAX_IMAGES} images. Free, unless --train also trains the image style (BILLED)`)
    .requiredOption('-i, --image <urlOrPath>', 'Reference image URL, local file, or a directory of images (repeatable)', collect, [] as string[])
    .option('--description <text>', 'What the style is')
    .option('--notes <text>', 'Extra guidance for using the style')
    .option('--train', 'Also train an image style adapter from the images (BILLED)')
    .option('--steps <n>', `With --train: training steps (${IMAGE_STYLE_MIN_STEPS}-${IMAGE_STYLE_MAX_STEPS})`)
    .option('--team <teamId>', 'With --train: bill the adapter to a workspace credit pool')
    .action(async (name: string, opts: {
      image: string[]; description?: string; notes?: string; train?: boolean; steps?: string; team?: string;
    }) => {
      const inputs = await expandMediaInputs(opts.image, IMAGE_EXTENSIONS);
      if (inputs.length < STYLE_SKILL_MIN_IMAGES || inputs.length > STYLE_SKILL_MAX_IMAGES) {
        throw new CliError(
          `A style skill takes ${STYLE_SKILL_MIN_IMAGES}–${STYLE_SKILL_MAX_IMAGES} images (got ${inputs.length}).`,
          'invalid_image_count'
        );
      }
      const steps = parseIntInRange(opts.steps, '--steps', IMAGE_STYLE_MIN_STEPS, IMAGE_STYLE_MAX_STEPS);
      if ((steps !== undefined || opts.team) && !opts.train) {
        throw new CliError('--steps and --team only apply with --train.', 'invalid_option');
      }
      const body = {
        name,
        image_urls: await uploadAll(inputs),
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.notes ? { notes: opts.notes } : {}),
        ...(opts.train ? { train: true } : {}),
        ...(steps !== undefined ? { steps } : {}),
        ...(opts.team ? { team_id: opts.team } : {})
      };
      const s = await publicApiRequest<any>('POST', '/style-skills', { body, idempotencyKey: randomUUID() });
      printResult(s, () => {
        process.stdout.write(`${green('✓')} Created style skill ${bold(s.title)}  ${dim(s.id)}\n`);
        if (s.moodboard_id) process.stdout.write(`${dim('Moodboard:')} ${s.moodboard_id}\n`);
        if (s.image_style) {
          process.stdout.write(`${dim('Training:')}  image style ${s.image_style.id} ${dim(`(${s.image_style.status})`)}\n`);
        } else if (s.training_error) {
          process.stdout.write(`${red('Training failed:')} ${s.training_error.code}: ${s.training_error.detail}\n`);
        } else if (s.lora_quote_credits != null) {
          process.stdout.write(`${dim(`Train its image style for ${s.lora_quote_credits} credits: genfire style-skills train ${s.id}`)}\n`);
        }
      });
    });

  skills
    .command('train <skillId>')
    .description('Train the image style adapter for an existing style skill. BILLED')
    .option('--steps <n>', `Training steps (${IMAGE_STYLE_MIN_STEPS}-${IMAGE_STYLE_MAX_STEPS})`)
    .option('--team <teamId>', 'Bill the training to a workspace credit pool instead of your own balance')
    .action(async (skillId: string, opts: { steps?: string; team?: string }) => {
      const steps = parseIntInRange(opts.steps, '--steps', IMAGE_STYLE_MIN_STEPS, IMAGE_STYLE_MAX_STEPS);
      const s = await publicApiRequest<any>('POST', `/style-skills/${encodeURIComponent(skillId)}/train`, {
        body: { ...(steps !== undefined ? { steps } : {}), ...(opts.team ? { team_id: opts.team } : {}) },
        idempotencyKey: randomUUID()
      });
      printResult(s, () => {
        process.stdout.write(`${green('✓')} Training image style ${bold(s.name)}  ${dim(s.id)} ${dim(`(${s.status})`)}\n`);
        process.stdout.write(`${dim('Check on it:')} genfire image-styles get ${s.id}\n`);
      });
    });
}

export function registerTrainingCommands(program: Command): void {
  registerImageStyles(program);
  registerTrainedModels(program);
  registerStyleSkills(program);
}
