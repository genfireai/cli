import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import type { CreateMusicVideoRequest } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, printResult, printTable } from '../output.js';
import {
  downloadOutputs,
  extractOutputUrls,
  reportRunCompletion,
  resolveMediaInput,
  waitForRun
} from '../runHelpers.js';

const ASPECT_RATIOS = new Set(['9:16', '16:9']);
const SCENE_DENSITIES = new Set(['low', 'medium', 'high']);

function parseAspectRatio(value: string | undefined): '9:16' | '16:9' | undefined {
  if (!value) return undefined;
  if (!ASPECT_RATIOS.has(value)) {
    throw new CliError(`Invalid --aspect-ratio: ${value}. Use 9:16 or 16:9.`, 'invalid_aspect_ratio');
  }
  return value as '9:16' | '16:9';
}

function parseSceneDensity(value: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!value) return undefined;
  if (!SCENE_DENSITIES.has(value)) {
    throw new CliError(`Invalid --scene-density: ${value}. Use low, medium, or high.`, 'invalid_scene_density');
  }
  return value as 'low' | 'medium' | 'high';
}

export function registerMusicVideosCommand(program: Command): void {
  const mv = program
    .command('music-videos')
    .description('Turn a song into a styled, scene-cut music video');

  mv
    .command('styles')
    .description('List the visual style presets accepted as --style')
    .action(async () => {
      const client = await createClient();
      const styles = await client.listMusicVideoStyles();
      printResult(styles, () => {
        printTable(
          styles.map((s) => ({ id: s.id, name: s.name, description: s.description })),
          ['id', 'name', 'description']
        );
      });
    });

  mv
    .command('estimate-cost')
    .description('Price a music video before generating it (song cost is billed separately)')
    .requiredOption('-d, --song-duration <seconds>', 'Length of the song in seconds')
    .option('-a, --aspect-ratio <ratio>', '9:16 (default) or 16:9')
    .option('--scene-density <level>', 'low (~10s/scene) | medium (~7s) | high (~5s)')
    .option('--lyric-captions', 'Include burned-in karaoke lyric captions in the estimate')
    .action(async (opts: {
      songDuration: string; aspectRatio?: string; sceneDensity?: string; lyricCaptions?: boolean;
    }) => {
      const seconds = Number(opts.songDuration);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new CliError(`Invalid --song-duration: ${opts.songDuration}`, 'invalid_duration');
      }
      const client = await createClient();
      const estimate = await client.estimateMusicVideoCost({
        song_duration_sec: seconds,
        aspect_ratio: parseAspectRatio(opts.aspectRatio),
        scene_density: parseSceneDensity(opts.sceneDensity),
        lyric_captions: opts.lyricCaptions
      });
      printResult(estimate, () => {
        process.stdout.write(`${bold(String(estimate.totalCredits))} credits ${dim(`· ${estimate.sceneCount} scenes`)}\n`);
        for (const line of estimate.breakdown) {
          process.stdout.write(`  ${dim(line.label.padEnd(28))} ${line.credits}\n`);
        }
        process.stdout.write(`${dim('Note: the song itself is billed separately when generated inline.')}\n`);
      });
    });

  mv
    .command('create <concept>')
    .description('Generate a music video from a song URL/file or an inline AI-generated track')
    .requiredOption('-s, --style <id>', 'Visual style preset id (see: genfire music-videos styles)')
    .option('--song <urlOrPath>', 'Bring-your-own song: URL or local path (auto-uploaded)')
    .option('--song-title <title>', 'Title for a bring-your-own track')
    .option('--song-prompt <text>', 'Generate the song inline instead: what it should sound like')
    .option('--song-duration <ms>', 'Inline song length in milliseconds (10000–600000)')
    .option('--instrumental', 'Inline song only: generate without vocals')
    .option('--transcribe-lyrics', 'Transcribe a bring-your-own song to derive lyrics + word timings (billed per second)')
    .option('-a, --aspect-ratio <ratio>', '9:16 (default) or 16:9')
    .option('--scene-density <level>', 'low | medium | high')
    .option('--lyric-captions', 'Burn karaoke-style lyric captions')
    .option('--influencer-id <id>', 'Bind a trained influencer so the same character appears across scenes')
    .option('--reference-image <urlOrPath...>', 'Up to 8 images (characters/products/looks) that should appear')
    .option('-o, --output <path>', 'Where to save the finished video')
    .option('--no-download', "Don't download the output; only print the URL")
    .option('--no-wait', 'Return the queued run immediately instead of polling')
    .option('--wait-timeout <minutes>', 'Maximum minutes to wait', '30')
    .action(async (concept: string, opts: {
      style: string; song?: string; songTitle?: string; songPrompt?: string; songDuration?: string;
      instrumental?: boolean; transcribeLyrics?: boolean; aspectRatio?: string; sceneDensity?: string;
      lyricCaptions?: boolean; influencerId?: string; referenceImage?: string[];
      output?: string; download: boolean; wait: boolean; waitTimeout: string;
    }) => {
      if (!opts.song && !opts.songPrompt) {
        throw new CliError(
          'Provide a song: --song <urlOrPath> for your own track, or --song-prompt to generate one inline.',
          'missing_song'
        );
      }
      if (opts.song && opts.songPrompt) {
        throw new CliError('Use either --song or --song-prompt, not both.', 'conflicting_song');
      }
      if (opts.songPrompt && !opts.songDuration) {
        throw new CliError('--song-duration <ms> is required with --song-prompt.', 'missing_song_duration');
      }

      const client = await createClient();
      const body: CreateMusicVideoRequest = {
        concept,
        style_preset_id: opts.style,
        aspect_ratio: parseAspectRatio(opts.aspectRatio),
        scene_density: parseSceneDensity(opts.sceneDensity),
        lyric_captions: opts.lyricCaptions,
        influencer_id: opts.influencerId
      };

      if (opts.song) {
        body.song_url = (await resolveMediaInput(client, opts.song)).url;
        body.song_title = opts.songTitle;
        body.transcribe_lyrics = opts.transcribeLyrics;
      } else {
        const durationMs = Number(opts.songDuration);
        if (!Number.isInteger(durationMs) || durationMs < 10000 || durationMs > 600000) {
          throw new CliError('--song-duration must be between 10000 and 600000 milliseconds.', 'invalid_song_duration');
        }
        body.song = {
          prompt: opts.songPrompt!,
          duration_ms: durationMs,
          instrumental: opts.instrumental
        };
      }

      if (opts.referenceImage?.length) {
        if (opts.referenceImage.length > 8) {
          throw new CliError('--reference-image accepts at most 8 images.', 'too_many_reference_images');
        }
        body.reference_images = [];
        for (const ref of opts.referenceImage) {
          body.reference_images.push({ url: (await resolveMediaInput(client, ref)).url });
        }
      }

      const run = await client.createMusicVideo(body, { idempotencyKey: randomUUID() });

      if (!opts.wait) {
        printResult(run, () => {
          process.stdout.write(`${dim('Run queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
          process.stdout.write(`${dim('Re-check with:')} genfire runs get ${run.id}\n`);
        });
        return;
      }

      const timeoutMinutes = Number(opts.waitTimeout);
      if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
        throw new CliError(`Invalid --wait-timeout: ${opts.waitTimeout}`, 'invalid_wait_timeout');
      }

      let lastStage = '';
      process.stderr.write(`${dim(`Polling run ${run.id}…`)}\n`);
      const completed = await waitForRun(client, run.id, {
        timeoutMs: timeoutMinutes * 60 * 1000,
        onTick: (current) => {
          const stage = current.progress?.label || current.status;
          if (stage && stage !== lastStage) {
            lastStage = stage;
            process.stderr.write(`${dim('  · ' + stage + '…')}\n`);
          }
        }
      });

      if (completed.status !== 'completed' || !opts.download) {
        reportRunCompletion(completed, []);
        return;
      }
      const outputs = extractOutputUrls(completed, 'music-video');
      if (outputs.length === 0) {
        reportRunCompletion(completed, []);
        return;
      }
      const written = await downloadOutputs(outputs, opts.output);
      reportRunCompletion(completed, written);
      if (completed.output?.live_url) {
        process.stderr.write(`${dim('Watch:')} ${cyan(String(completed.output.live_url))}\n`);
      }
    });
}
