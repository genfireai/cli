import { Command } from 'commander';
import { GenFireClient } from '@genfire/sdk';
import { randomUUID } from 'node:crypto';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { dim, printResult, yellow } from '../output.js';
import {
  downloadOutputs,
  extractOutputUrls,
  reportRunCompletion,
  resolveMediaInput,
  waitForRun
} from '../runHelpers.js';
import { resolveMentionFromPrompt } from './influencers.js';

interface CommonGenerateOptions {
  output?: string;
  noDownload?: boolean;
  wait: boolean;
  waitTimeout: string;
  waitInterval: string;
}

function parseDurationSeconds(value: string, flag: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) {
    throw new CliError(`Invalid duration for ${flag}: ${value}`, 'invalid_duration');
  }
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms') return Math.max(1, Math.round(amount));
  if (unit === 'm') return Math.round(amount * 60 * 1000);
  return Math.round(amount * 1000);
}

function commonOptions(cmd: Command): Command {
  return cmd
    .option('-o, --output <path>', 'Where to save the output. Single file path or directory; defaults to cwd')
    .option('--no-download', "Don't download outputs locally; only print the URLs")
    .option('--wait, --no-wait', 'Wait for the run to complete (default: wait)', true)
    .option('--wait-timeout <duration>', 'Maximum time to wait, e.g. 15m, 600s', '15m')
    .option('--wait-interval <duration>', 'Polling interval while waiting', '2s');
}

async function maybeFinish(
  client: GenFireClient,
  runId: string,
  fallbackBase: string,
  options: CommonGenerateOptions
): Promise<void> {
  if (!options.wait) {
    const run = await client.getRun(runId);
    printResult(run, () => {
      process.stderr.write(`${dim('Run queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
      process.stderr.write(`${dim('Re-check with:')} genfire runs get ${run.id}\n`);
    });
    return;
  }

  const intervalMs = parseDurationSeconds(options.waitInterval, '--wait-interval');
  const timeoutMs = parseDurationSeconds(options.waitTimeout, '--wait-timeout');

  process.stderr.write(`${dim(`Polling run ${runId}...`)}\n`);
  const run = await waitForRun(client, runId, {
    intervalMs,
    timeoutMs,
    onTick: (current, elapsed) => {
      if (current.status !== 'completed' && current.status !== 'failed') {
        process.stderr.write(`${dim(`  status=${current.status} elapsed=${Math.round(elapsed / 1000)}s\r`)}`);
      }
    }
  });
  process.stderr.write('\n');

  if (run.status !== 'completed' || options.noDownload) {
    reportRunCompletion(run, []);
    return;
  }

  const outputs = extractOutputUrls(run, fallbackBase);
  if (outputs.length === 0) {
    reportRunCompletion(run, []);
    return;
  }
  const written = await downloadOutputs(outputs, options.output);
  reportRunCompletion(run, written);
}

export function registerGenerateCommands(program: Command): void {
  const generate = program.command('generate').description('Generate media (image, video, lipsync, speech, music, sfx)');

  // ---- image ----
  commonOptions(
    generate
      .command('image <prompt>')
      .description('Generate one or more images from a prompt. Use @<handle> to reference a trained influencer.')
  )
    .option('-m, --model <model>', 'Public model alias, e.g. image.nano_banana_2')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio, e.g. 1:1, 16:9')
    .option('-n, --count <n>', 'Number of images (1-4)', '1')
    .option('-i, --image <urlOrPath>', 'Reference image URL or local path (auto-uploaded)')
    .option('--influencer <id>', 'Explicit influencer id (alternative to @handle in the prompt)')
    .option('--quality <level>', 'Image quality: low, medium, high, auto (image.gpt_image_2 only)')
    .option('--resolution <res>', 'Output resolution: 1K, 2K, 4K (nano-banana family edit only — supply --image or @<handle>)')
    .action(async (prompt: string, opts: CommonGenerateOptions & {
      model?: string; aspectRatio?: string; count?: string; image?: string; influencer?: string;
      quality?: string; resolution?: string;
    }) => {
      const client = await createClient();
      const count = Number(opts.count);
      if (!Number.isInteger(count) || count < 1 || count > 4) {
        throw new CliError('--count must be an integer 1-4', 'invalid_count');
      }
      const imageUrl = opts.image ? (await resolveMediaInput(client, opts.image)).url : undefined;

      // Resolve mention: explicit --influencer wins; otherwise scan prompt for @<handle>.
      let mentions: Array<{ handle: string; influencer_id: string }> | undefined;
      if (opts.influencer) {
        const explicit = await client.getInfluencer(opts.influencer);
        mentions = [{ handle: explicit.handle, influencer_id: explicit.id }];
      } else {
        const fromPrompt = await resolveMentionFromPrompt(prompt, client);
        if (fromPrompt) mentions = [fromPrompt];
      }

      const VALID_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
      const VALID_RESOLUTIONS = new Set(['1K', '2K', '4K']);

      if (opts.quality && !VALID_QUALITIES.has(opts.quality)) {
        throw new CliError('--quality must be one of: low, medium, high, auto', 'invalid_quality');
      }
      if (opts.resolution && !VALID_RESOLUTIONS.has(opts.resolution)) {
        throw new CliError('--resolution must be one of: 1K, 2K, 4K', 'invalid_resolution');
      }

      const run = await client.createImageGeneration(
        {
          prompt,
          model: opts.model,
          aspect_ratio: opts.aspectRatio,
          count,
          image_url: imageUrl,
          mentions,
          quality: opts.quality as 'low' | 'medium' | 'high' | 'auto' | undefined,
          resolution: opts.resolution as '1K' | '2K' | '4K' | undefined
        },
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'image', opts);
    });

  // ---- video ----
  commonOptions(
    generate
      .command('video <prompt>')
      .description('Generate a video from a prompt (and optional reference image)')
  )
    .option('-m, --model <model>', 'Public model alias, e.g. video.veo_3_1')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio (16:9, 9:16, 1:1)')
    .option('-d, --duration <seconds>', 'Duration in seconds (model-dependent)')
    .option('-i, --image <urlOrPath>', 'Reference image URL or local path (auto-uploaded)')
    .option('--no-audio', 'Disable audio generation if the model supports it')
    .action(async (prompt: string, opts: CommonGenerateOptions & {
      model?: string; aspectRatio?: string; duration?: string; image?: string; audio: boolean;
    }) => {
      const client = await createClient();
      const imageUrl = opts.image ? (await resolveMediaInput(client, opts.image)).url : undefined;
      const run = await client.createVideoGeneration(
        {
          prompt,
          model: opts.model,
          aspect_ratio: opts.aspectRatio,
          duration: opts.duration ? Number(opts.duration) : undefined,
          image_url: imageUrl,
          generate_audio: opts.audio === false ? false : undefined
        },
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'video', opts);
    });

  // ---- speech ----
  commonOptions(
    generate
      .command('speech <text>')
      .description('Synthesize speech from text')
  )
    .requiredOption('--voice-id <id>', 'Voice id to use')
    .option('-m, --model <model>', 'Speech model alias')
    .option('--voice-name <name>', 'Optional friendly voice name for logs')
    .option('--format <format>', 'Output format, e.g. mp3_44100_128')
    .action(async (text: string, opts: CommonGenerateOptions & {
      model?: string; voiceId: string; voiceName?: string; format?: string;
    }) => {
      const client = await createClient();
      const run = await client.createSpeech(
        {
          text,
          voice_id: opts.voiceId,
          voice_name: opts.voiceName,
          model: opts.model,
          output_format: opts.format
        },
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'speech', opts);
    });

  // ---- music ----
  commonOptions(
    generate
      .command('music <prompt>')
      .description('Generate music from a prompt')
  )
    .option('-m, --model <model>', 'Music model alias')
    .option('-d, --duration <seconds>', 'Duration in seconds')
    .option('--format <format>', 'Output format')
    .option('--instrumental', 'Force an instrumental (no vocals)')
    .action(async (prompt: string, opts: CommonGenerateOptions & {
      model?: string; duration?: string; format?: string; instrumental?: boolean;
    }) => {
      const client = await createClient();
      const run = await client.createMusic(
        {
          prompt,
          model: opts.model,
          duration_seconds: opts.duration ? Number(opts.duration) : undefined,
          output_format: opts.format,
          force_instrumental: opts.instrumental
        },
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'music', opts);
    });

  // ---- sfx ----
  commonOptions(
    generate
      .command('sfx <prompt>')
      .description('Generate a sound effect from a prompt')
  )
    .option('-m, --model <model>', 'SFX model alias')
    .option('-d, --duration <seconds>', 'Duration in seconds')
    .option('--format <format>', 'Output format')
    .option('--prompt-influence <weight>', 'Prompt influence (0..1)')
    .option('--loop', 'Loop the generated sound')
    .action(async (prompt: string, opts: CommonGenerateOptions & {
      model?: string; duration?: string; format?: string; promptInfluence?: string; loop?: boolean;
    }) => {
      const client = await createClient();
      const run = await client.createSoundEffect(
        {
          prompt,
          model: opts.model,
          duration_seconds: opts.duration ? Number(opts.duration) : undefined,
          output_format: opts.format,
          prompt_influence: opts.promptInfluence ? Number(opts.promptInfluence) : undefined,
          loop: opts.loop
        },
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'sfx', opts);
    });

  // ---- lipsync ----
  commonOptions(
    generate
      .command('lipsync')
      .description('Lip-sync a video to an audio track')
  )
    .requiredOption('--video <urlOrPath>', 'Source video URL or local path (auto-uploaded)')
    .requiredOption('--audio <urlOrPath>', 'Source audio URL or local path (auto-uploaded)')
    .option('-m, --model <model>', 'Lipsync model alias')
    .option('--sync-mode <mode>', 'Sync mode: cut_off, loop, bounce, silence, remap')
    .option('--title <title>', 'Optional title')
    .option('--description <description>', 'Optional description')
    .option('-d, --duration <seconds>', 'Duration override')
    .action(async (opts: CommonGenerateOptions & {
      video: string; audio: string; model?: string;
      syncMode?: string; title?: string; description?: string; duration?: string;
    }) => {
      const client = await createClient();
      const videoUrl = (await resolveMediaInput(client, opts.video)).url;
      const audioUrl = (await resolveMediaInput(client, opts.audio)).url;
      const validSyncModes = new Set(['cut_off', 'loop', 'bounce', 'silence', 'remap']);
      if (opts.syncMode && !validSyncModes.has(opts.syncMode)) {
        throw new CliError(`Invalid --sync-mode: ${opts.syncMode}`, 'invalid_sync_mode');
      }
      const run = await client.createLipsyncGeneration(
        {
          video_url: videoUrl,
          audio_url: audioUrl,
          model: opts.model,
          sync_mode: opts.syncMode as ('cut_off' | 'loop' | 'bounce' | 'silence' | 'remap') | undefined,
          title: opts.title,
          description: opts.description,
          duration: opts.duration ? Number(opts.duration) : undefined
        },
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'lipsync', opts);
    });

  // ---- upload (raw, no generation) ----
  generate
    .command('upload <path>')
    .description('Upload a local file and print its asset URL (useful for chaining with other tools)')
    .action(async (path: string) => {
      const client = await createClient();
      const upload = await client.uploadFile(path);
      printResult(upload, () => {
        process.stdout.write(`${upload.asset_url}\n`);
        process.stderr.write(
          `${dim('asset_id:')}    ${upload.asset_id}\n` +
          `${dim('content_type:')} ${upload.content_type}\n` +
          `${dim('expires_at:')}  ${upload.expires_at}\n`
        );
        if (new Date(upload.expires_at).getTime() - Date.now() < 24 * 60 * 60 * 1000) {
          process.stderr.write(`${yellow('Warning:')} asset_url expires in less than 24h.\n`);
        }
      });
    });
}
