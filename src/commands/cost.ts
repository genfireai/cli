import { readFile } from 'node:fs/promises';
import { publicApiRequest } from '../client.js';
import { Command } from 'commander';
import { createClient } from '../client.js';
import { bold, cyan, dim, printJson, printResult, yellow } from '../output.js';
import type { EstimateCostRequest, GenFireClient } from '@genfire/sdk';
import { CliError } from '../errors.js';
import { resolveMediaInput } from '../runHelpers.js';
import {
  addImageRequestOptions,
  addVideoRequestOptions,
  buildImageRequest,
  buildVideoRequest,
  type ImageFlags,
  type VideoFlags,
  buildSpeechExtras
} from '../generationRequests.js';

/** Local paths upload and run ids resolve, exactly as on `generate`. */
function mediaResolver(client: GenFireClient) {
  return async (input: string) => (await resolveMediaInput(client, input)).url;
}

/**
 * The estimate endpoint needs a model; `generate` falls back to the API
 * default. Price the default the same way — but the quote fingerprint hashes
 * the RAW `model` field, so the default is named explicitly in the output and
 * the user is told to pass it to `generate` alongside `--quote`. A marketing
 * template supplies its own model server-side, so it is left alone.
 */
async function withDefaultModel(
  client: GenFireClient,
  body: Record<string, unknown>,
  capability: 'image_generation' | 'video_generation'
): Promise<Record<string, unknown>> {
  if (body.model || body.marketing_template_id) return body;
  const models = await client.listModels();
  const fallback = models.data.find((m) => m.capability === capability && m.is_default);
  if (!fallback) {
    throw new CliError(`No default ${capability} model — pass -m <model>.`, 'missing_model');
  }
  process.stderr.write(
    `${dim(`No -m given — pricing the default model ${fallback.id}. Pass \`-m ${fallback.id}\` to generate too if you use --quote.`)}\n`
  );
  return { ...body, model: fallback.id };
}

export function registerCostCommand(program: Command): void {
  const cost = program.command('cost').description('Estimate the EXACT credit cost of a generation before running it');

  cost.command('request <file>').description('Estimate a complete generation request, including references, templates and task routing')
    .action(async(file:string)=>printJson(await publicApiRequest('POST','/models/estimate-cost',{body:JSON.parse(await readFile(file,'utf8'))})));

  // image / video take EXACTLY the flags `genfire generate image|video` take
  // (generationRequests.ts builds both bodies) so the price quoted here — and
  // its quote_token — is the price the real call is charged.
  addImageRequestOptions(
    cost
      .command('image [prompt]')
      .description('Estimate the credit cost of an image generation — accepts every `generate image` flag')
  )
    .action(async (_prompt: string | undefined, opts: ImageFlags) => {
      const client = await createClient();
      const body = await buildImageRequest(opts, mediaResolver(client));
      await runEstimate(await withDefaultModel(client, body, 'image_generation'));
    });

  addVideoRequestOptions(
    cost
      .command('video [prompt]')
      .description('Estimate the credit cost of a video generation — accepts every `generate video` flag, so references, source clips, Gedi tasks and LoRAs route (and price) like the real call')
  )
    .option('-n, --count <n>', 'Number of clips to price (estimate only — each `generate video` run makes one)')
    .option('--image-url <url>', 'Deprecated alias of --image')
    .option('--reference-image-urls <urls>', 'Deprecated: comma-separated form of --ref-image')
    .action(async (_prompt: string | undefined, opts: VideoFlags & { count?: string; imageUrl?: string; referenceImageUrls?: string }) => {
      const merged: VideoFlags = {
        ...opts,
        image: opts.image ?? opts.imageUrl,
        refImage: [
          ...(opts.refImage ?? []),
          ...(opts.referenceImageUrls ? opts.referenceImageUrls.split(',').map((s) => s.trim()).filter(Boolean) : [])
        ]
      };
      if (merged.refImage!.length === 0) delete merged.refImage;
      const client = await createClient();
      const body = await buildVideoRequest(merged, mediaResolver(client));
      if (opts.count) body.count = Number(opts.count);
      await runEstimate(await withDefaultModel(client, body, 'video_generation'));
    });

  cost
    .command('speech [text]')
    .description('Estimate the credit cost of a speech generation (or a --dialogue-file dialogue)')
    .option('-m, --model <model>', 'Public speech model alias (required unless --dialogue-file, which implies speech.elevenlabs_dialogue_v3)')
    .option('--voice-id <id>', 'Voice id (affects the billing rate)')
    .option('--dialogue-file <path>', 'JSON array of { text, voice_id } lines — priced on the characters across all lines')
    .action(async (text: string | undefined, opts: { model?: string; voiceId?: string; dialogueFile?: string }) => {
      const extra = await buildSpeechExtras(text, { dialogueFile: opts.dialogueFile });
      const model = opts.model ?? (extra.dialogue ? 'speech.elevenlabs_dialogue_v3' : undefined);
      if (!model) throw new CliError('-m, --model is required.', 'missing_model');
      await runEstimate({ model, text, voice_id: opts.voiceId, ...(extra.dialogue ? { dialogue: extra.dialogue } : {}) });
    });

  cost
    .command('music [prompt]')
    .description('Estimate the credit cost of a music generation')
    .requiredOption('-m, --model <model>', 'Public music model alias')
    .option('-d, --duration <seconds>', 'Duration in seconds')
    .option('--plan-file <path>', 'ElevenLabs composition plan JSON — its own total length is priced when -d is omitted')
    .option('--details', 'Include detailed metadata')
    .option('--timestamps', 'Include timestamps (implies --details)')
    .action(async (_prompt: string | undefined, opts: { model: string; duration?: string; planFile?: string; details?: boolean; timestamps?: boolean }) => {
      let compositionPlan: unknown;
      if (opts.planFile) {
        try {
          compositionPlan = JSON.parse(await readFile(opts.planFile, 'utf8'));
        } catch (err) {
          throw new CliError(`Could not read --plan-file ${opts.planFile}: ${(err as Error).message}`, 'invalid_plan_file');
        }
      }
      await runEstimate({
        model: opts.model,
        duration_seconds: opts.duration ? Number(opts.duration) : undefined,
        composition_plan: compositionPlan,
        // Same spelling `generate music` sends (undefined unless set).
        include_details: opts.details || opts.timestamps || undefined,
        with_timestamps: opts.timestamps || undefined
      });
    });

  cost
    .command('transcribe')
    .description('Estimate the credit cost of a transcription (the run measures the audio itself; pass its length here)')
    .option('-m, --model <model>', 'Transcription model alias', 'transcription.whisper_v1')
    .requiredOption('-d, --duration <seconds>', 'Audio length in seconds')
    .action(async (opts: { model: string; duration: string }) => {
      await runEstimate({ model: opts.model, duration_seconds: Number(opts.duration) });
    });

  cost
    .command('upscale-video')
    .description('Estimate the credit cost of a video upscale (Topaz or Flux)')
    .option('-s, --scale <factor>', 'Scale factor: 2 or 4 (Topaz), 1.5–3 (Flux)', '2')
    .option('-e, --engine <engine>', 'Engine: topaz or flux', 'topaz')
    .option('--mode <mode>', 'Flux only: precise or creative', 'creative')
    .option('-d, --duration <seconds>', 'Source clip length in seconds')
    .option('--width <px>', 'Source width in pixels')
    .option('--height <px>', 'Source height in pixels')
    .action(async (opts: { scale: string; engine: string; mode: string; duration?: string; width?: string; height?: string }) => {
      const engine = String(opts.engine || 'topaz').toLowerCase();
      if (engine !== 'topaz' && engine !== 'flux') {
        throw new CliError(`Invalid --engine: ${opts.engine}. Use topaz or flux.`, 'invalid_engine');
      }
      await runEstimate({
        model: engine === 'flux' ? 'video_upscale.flux_video_upscale' : 'video_upscale.fal_video_upscaler',
        scale_factor: Number(opts.scale),
        ...(engine === 'flux' ? { mode: opts.mode } : {}),
        duration: opts.duration ? Number(opts.duration) : undefined,
        source_width: opts.width ? Number(opts.width) : undefined,
        source_height: opts.height ? Number(opts.height) : undefined
      });
    });

  cost
    .command('sfx <prompt>')
    .description('Estimate the credit cost of a sound effect generation')
    .requiredOption('-m, --model <model>', 'Public SFX model alias')
    .option('-d, --duration <seconds>', 'Duration in seconds')
    .action(async (_prompt: string, opts: { model: string; duration?: string }) => {
      await runEstimate({ model: opts.model, duration_seconds: opts.duration ? Number(opts.duration) : undefined });
    });

  cost
    .command('3d')
    .description('Estimate the credit cost of a 3D model generation')
    .requiredOption('-m, --model <model>', 'Public 3D model alias, e.g. 3d.meshy_v7')
    .option('--no-texture', 'Mesh only (no textures)')
    .option('--pbr', 'Enable PBR maps')
    .option('--rigging', 'Enable auto-rigging')
    .action(async (opts: { model: string; texture?: boolean; pbr?: boolean; rigging?: boolean }) => {
      await runEstimate({
        model: opts.model,
        should_texture: opts.texture,
        enable_pbr: opts.pbr,
        enable_rigging: opts.rigging
      });
    });

  cost
    .command('lipsync')
    .description('Estimate the credit cost of a lipsync generation')
    .requiredOption('-m, --model <model>', 'Public lipsync model alias')
    .option('-d, --duration <seconds>', 'Audio duration in seconds')
    .option('--audio <urlOrPath>', 'The audio track, as on `generate lipsync` (URL, local path or run id) — its length is priced when -d is omitted')
    .option('--audio-url <url>', 'Deprecated alias of --audio')
    .option('--resolution <resolution>', 'lipsync.h3_max_lipsync only: 480P, 768P, 1080P or 2K')
    .action(async (opts: { model: string; duration?: string; audio?: string; audioUrl?: string; resolution?: string }) => {
      const audio = opts.audio ?? opts.audioUrl;
      const client = await createClient();
      await runEstimate({
        model: opts.model,
        duration: opts.duration ? Number(opts.duration) : undefined,
        // `generate lipsync` always sends audio_url, and the quote keys its
        // presence — so pass --audio here for a spendable quote.
        audio_url: audio ? (await resolveMediaInput(client, audio)).url : undefined,
        // Uppercased like `generate lipsync` does.
        resolution: opts.resolution?.toUpperCase()
      });
    });
}

async function runEstimate(input: EstimateCostRequest | Record<string, unknown>): Promise<void> {
  const client = await createClient();
  const [estimate, credits] = await Promise.all([
    client.estimateCost(input as EstimateCostRequest),
    client.getCredits().catch(() => null)
  ]);

  printResult(
    {
      ...estimate,
      balance: credits ? { balance: credits.balance, currency: credits.currency } : undefined
    },
    () => {
      process.stdout.write(`${bold(estimate.model)}  ${dim(estimate.capability)}\n`);
      process.stdout.write(`${dim('Cost:')}     ${cyan(String(estimate.credits))} credits\n`);
      const bd = estimate.breakdown as Record<string, unknown>;
      for (const [key, value] of Object.entries(bd)) {
        process.stdout.write(`${dim(`  ${key}:`)} ${String(value)}\n`);
      }
      if (credits) {
        const remaining = credits.balance - estimate.credits;
        const tag = remaining < 0 ? yellow(`(would go negative by ${-remaining})`) : `(${remaining} remaining)`;
        process.stdout.write(`${dim('Balance:')}  ${credits.balance} ${tag}\n`);
      }
      // The RECEIPT. Without it the price above is a number the user was shown
      // and the charge is whatever the submit recomputes; with it, `--quote`
      // binds the two. Not on the pinned SDK's CostEstimate type yet (the SDK
      // source carries it) — see the scopeFields note in commands/generate.ts.
      const quote = estimate as unknown as { quote_token?: string; expires_at?: string };
      if (quote.quote_token) {
        process.stdout.write(
          `${dim('Quote:')}    ${quote.quote_token}\n` +
          `${dim(`          pass it as --quote to be charged this price${quote.expires_at ? ` (expires ${quote.expires_at})` : ''}\n`)}`
        );
      }
    }
  );
}
