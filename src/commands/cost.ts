import { Command } from 'commander';
import { createClient } from '../client.js';
import { bold, cyan, dim, printResult, yellow } from '../output.js';
import type { EstimateCostRequest } from '@genfire/sdk';

export function registerCostCommand(program: Command): void {
  const cost = program.command('cost').description('Estimate the EXACT credit cost of a generation before running it');

  cost
    .command('image <prompt>')
    .description('Estimate the credit cost of an image generation')
    .requiredOption('-m, --model <model>', 'Public model alias, e.g. image.nano_banana_2')
    .option('-n, --count <n>', 'Number of images')
    .option('-r, --resolution <res>', 'Resolution (e.g. 1K, 2K, 4K)')
    .option('-q, --quality <quality>', 'Quality tier (low, medium, high) — GPT Image 2 / GenFire')
    .action(async (_prompt: string, opts: { model: string; count?: string; resolution?: string; quality?: string }) => {
      await runEstimate({
        model: opts.model,
        count: opts.count ? Number(opts.count) : undefined,
        resolution: opts.resolution,
        quality: opts.quality
      });
    });

  cost
    .command('video <prompt>')
    .description('Estimate the credit cost of a video generation')
    .requiredOption('-m, --model <model>', 'Public model alias, e.g. video.seedance_2_0')
    .option('-d, --duration <seconds>', 'Duration in seconds')
    .option('-r, --resolution <res>', 'Resolution (e.g. 480p, 720p, 1080p, 4k)')
    .option('-n, --count <n>', 'Number of videos')
    .option('--no-audio', 'Disable generated audio')
    .option('--image-url <url>', 'Start image (image-to-video)')
    .option('--reference-image-urls <urls>', 'Comma-separated reference images (reference-to-video)')
    .action(async (_prompt: string, opts: { model: string; duration?: string; resolution?: string; count?: string; audio?: boolean; imageUrl?: string; referenceImageUrls?: string }) => {
      await runEstimate({
        model: opts.model,
        duration: opts.duration ? Number(opts.duration) : undefined,
        resolution: opts.resolution,
        count: opts.count ? Number(opts.count) : undefined,
        generate_audio: opts.audio,
        image_url: opts.imageUrl,
        reference_image_urls: opts.referenceImageUrls ? opts.referenceImageUrls.split(',').map((s) => s.trim()).filter(Boolean) : undefined
      });
    });

  cost
    .command('speech <text>')
    .description('Estimate the credit cost of a speech generation')
    .requiredOption('-m, --model <model>', 'Public speech model alias')
    .option('--voice-id <id>', 'Voice id (affects FAL vs ElevenLabs billing)')
    .action(async (text: string, opts: { model: string; voiceId?: string }) => {
      await runEstimate({ model: opts.model, text, voice_id: opts.voiceId });
    });

  cost
    .command('music <prompt>')
    .description('Estimate the credit cost of a music generation')
    .requiredOption('-m, --model <model>', 'Public music model alias')
    .option('-d, --duration <seconds>', 'Duration in seconds')
    .option('--details', 'Include detailed metadata')
    .option('--timestamps', 'Include timestamps (implies --details)')
    .action(async (_prompt: string, opts: { model: string; duration?: string; details?: boolean; timestamps?: boolean }) => {
      await runEstimate({
        model: opts.model,
        duration_seconds: opts.duration ? Number(opts.duration) : undefined,
        include_details: opts.details || opts.timestamps,
        with_timestamps: opts.timestamps
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
    .requiredOption('-m, --model <model>', 'Public 3D model alias, e.g. 3d.meshy_v6')
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
    .option('--audio-url <url>', 'Audio URL (used to estimate duration when --duration is omitted)')
    .action(async (opts: { model: string; duration?: string; audioUrl?: string }) => {
      await runEstimate({
        model: opts.model,
        duration: opts.duration ? Number(opts.duration) : undefined,
        audio_url: opts.audioUrl
      });
    });
}

async function runEstimate(input: EstimateCostRequest): Promise<void> {
  const client = await createClient();
  const [estimate, credits] = await Promise.all([
    client.estimateCost(input),
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
    }
  );
}
