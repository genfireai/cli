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
import { readExplainerScriptFile } from './explainers.js';

interface CommonGenerateOptions {
  output?: string;
  download: boolean;
  wait: boolean;
  waitTimeout: string;
  waitInterval: string;
  /** --team: which credit pool pays. */
  team?: string;
  /** --project: where the output is filed. Only on commands whose capability files. */
  project?: string;
  /** --quote: spend a price `genfire cost estimate` already showed. */
  quote?: string;
}

/**
 * `--team` / `--project` / `--quote`, as the wire fields the API takes.
 *
 * Spread into the request and cast at the call site rather than typed on the
 * SDK request objects: the CLI pins @genfire/sdk 0.23.0, whose request types
 * predate run scoping and price quotes. The SDK SOURCE in this repo carries
 * them now (TeamBillable / ProjectFileable / Quotable), so these casts come out
 * on the next SDK cut — same arrangement as `publicApiRequest` in client.ts.
 * The API accepts all three today.
 */
function scopeFields(opts: CommonGenerateOptions): Record<string, string> {
  return {
    ...(opts.team ? { team_id: opts.team } : {}),
    ...(opts.project ? { project_id: opts.project } : {}),
    ...(opts.quote ? { quote_token: opts.quote } : {})
  };
}

/**
 * Read + parse an ElevenLabs music composition plan from a JSON file (the
 * `--plan-file` flag on `generate music`). The file must contain the plan
 * object itself: { sections: [...] } (music_v1) or { chunks: [...] } (music_v2).
 */
async function readLyricsFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new CliError(`Could not read --lyrics-file ${path}: ${(err as Error).message}`, 'invalid_lyrics_file');
  }
}

async function readMusicPlanFile(path: string): Promise<Record<string, unknown>> {
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new CliError(`Could not read --plan-file ${path}: ${(err as Error).message}`, 'invalid_plan_file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`--plan-file ${path} is not valid JSON: ${(err as Error).message}`, 'invalid_plan_file');
  }
  const plan = parsed as Record<string, unknown> | null;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || (!Array.isArray(plan.sections) && !Array.isArray(plan.chunks))) {
    throw new CliError(
      `--plan-file ${path} must contain a composition plan object with a sections (music_v1) or chunks (music_v2) array`,
      'invalid_plan_file'
    );
  }
  return plan;
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

/**
 * `fileable` is not cosmetic. `project_id` is a 400
 * (`project_filing_unsupported`) on any capability whose output is not an
 * image, video or audio a project can hold — upscales, 3D models and faceless
 * reels among them — so the flag is offered only where the API will take it,
 * rather than accepted here and rejected at the far end.
 */
function commonOptions(cmd: Command, opts: { fileable?: boolean } = {}): Command {
  const withCommon = cmd
    .option('-o, --output <path>', 'Where to save the output. Single file path or directory; defaults to cwd')
    .option('--no-download', "Don't download outputs locally; only print the URLs")
    .option('--no-wait', "Don't wait for the run to finish; print the queued run and exit")
    .option('--wait-timeout <duration>', 'Maximum time to wait, e.g. 15m, 600s', '15m')
    .option('--wait-interval <duration>', 'Polling interval while waiting', '2s')
    .option('--team <teamId>', 'Bill this run to a workspace credit pool instead of your own balance')
    .option('--quote <token>', 'A quote_token from `genfire cost estimate` — charges the price you were quoted');
  return opts.fileable
    ? withCommon.option('--project <projectId>', 'File the result into this project when it completes')
    : withCommon;
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

  if (run.status !== 'completed' || !options.download) {
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
  const generate = program.command('generate').description('Generate media (image, video, lipsync, speech, music, sfx, faceless-reel, explainer)');

  // ---- image ----
  commonOptions(
    generate
      .command('image <prompt>')
      .description('Generate one or more images from a prompt. Use @<handle> to reference a trained influencer.')
  , { fileable: true })
    .option('-m, --model <model>', 'Public model alias, e.g. image.nano_banana_2')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio, e.g. 1:1, 16:9')
    .option('-n, --count <n>', 'Number of images (1-4)', '1')
    .option(
      '-i, --image <urlOrPath>',
      'Reference image URL or local path (auto-uploaded). Repeat -i for a multi-image edit (up to 14; GPT Image 2 / Seedream / Qwen / Nano Banana — Grok uses the first 3).',
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[]
    )
    .option('--influencer <id>', 'Explicit influencer id (alternative to @handle in the prompt)')
    .option('--quality <level>', 'Image quality tier: low, medium, high, auto (image.gpt_image_2) — image.grok_imagine_2 takes low or medium')
    .option('--resolution <res>', 'Output resolution: 1K, 2K, 4K (image.grok_imagine_pro / image.grok_imagine_2 = 1K or 2K; nano-banana family edit only — supply --image or @<handle>)')
    .action(async (prompt: string, opts: CommonGenerateOptions & {
      model?: string; aspectRatio?: string; count?: string; image?: string[]; influencer?: string;
      quality?: string; resolution?: string;
    }) => {
      const client = await createClient();
      const count = Number(opts.count);
      if (!Number.isInteger(count) || count < 1 || count > 4) {
        throw new CliError('--count must be an integer 1-4', 'invalid_count');
      }
      const imageInputs = opts.image ?? [];
      if (imageInputs.length > 14) {
        throw new CliError('At most 14 -i/--image inputs are allowed for a multi-image edit', 'too_many_images');
      }
      const resolvedImageUrls: string[] = [];
      for (const input of imageInputs) {
        resolvedImageUrls.push((await resolveMediaInput(client, input)).url);
      }
      const imageUrl = resolvedImageUrls.length === 1 ? resolvedImageUrls[0] : undefined;
      const imageUrls = resolvedImageUrls.length > 1 ? resolvedImageUrls : undefined;

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
          image_urls: imageUrls,
          mentions,
          quality: opts.quality as 'low' | 'medium' | 'high' | 'auto' | undefined,
          resolution: opts.resolution as '1K' | '2K' | '4K' | undefined,
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'image', opts);
    });

  // ---- video ----
  commonOptions(
    generate
      .command('video <prompt>')
      .description('Generate a video from a prompt (and optional reference image)')
  , { fileable: true })
    .option('-m, --model <model>', 'Public model alias, e.g. video.veo_3_1')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio (16:9, 9:16, 1:1)')
    .option('-d, --duration <seconds>', 'Duration in seconds (model-dependent)')
    .option('-r, --resolution <resolution>', 'Output resolution, model-dependent (e.g. 480p, 720p, 1080p, 4k). Higher resolutions cost more credits.')
    .option('-i, --image <urlOrPath>', 'Reference image URL or local path (auto-uploaded)')
    .option('--end-image <urlOrPath>', 'Last frame the clip lands on — URL or local path, paired with --image. Supported where capabilities.endFrame is true (Seedance, Kling V3/O3/2.6, Hailuo 03/02 Standard)')
    .option('--ref-image <urlOrPath...>', 'Reference image URL(s) or local paths — cite in the prompt as Image 1, Image 2, … (Hailuo 03, Wan 3.0) or @Image1, @Image2, … (Seedance). Up to 9 on most models, 10 on Wan 3.0 / Omni Flash 1.1, 30 on video.seedance_2_5')
    .option('--ref-video <urlOrPath...>', 'Reference clip URL(s) or local paths — cite as Video 1… (Hailuo 03, Wan 3.0) or @Video1… (Seedance). Up to 3 on Hailuo 03 and Seedance 2.0, 5 on Wan 3.0 (15s total), 10 on video.seedance_2_5 (each 1.8-30.2s, 30.2s TOTAL across the pool). On video.seedance_2_5 this is also the clip --task edits or transfers motion from')
    .option('--ref-video-trim <spec...>', 'Time window for a --ref-video clip, as N:START-END in seconds (0-based N), e.g. --ref-video-trim 1:3-8 uses seconds 3–8 of the second clip. Only the window is sent. Must fit the model\'s per-clip cap (3s Omni Flash 1.1, 15s Hailuo 03 / Wan 3.0, 30s Seedance)')
    .option('--ref-audio <urlOrPath...>', 'Reference audio URL(s) or local paths, up to 3, 2-15s each — cite as Audio 1..Audio 3. Gives a character a consistent voice ("the woman in Image 1 speaks with the voice in Audio 1"). Needs at least one --ref-image or --ref-video alongside it (Hailuo 03 only)')
    .option('--no-audio', 'Disable audio generation if the model supports it')
    .option('--bitrate <mode>', 'Output encode quality: standard or high (high = larger, higher-quality file at no extra cost). Seedance 2.0 Standard/Fast and Seedance 2.5 only')
    .option('--bitrate-mode <mode>', 'Alias of --bitrate (kept for scripts written before --bitrate existed)')
    .option('--task <task>', 'GENFIRE GEDI, video.seedance_2_5 only: reference (motion transfer — the --ref-video supplies the motion, --ref-image supplies who performs it), editing (video edit — re-light, swap, clean up the --ref-video itself; the output follows the source, so leave -a and -d off) or extension (continue the clip). editing and extension need a --ref-video. Recipes with the prompts written for you: genfire gedi presets')
    .action(async (prompt: string, opts: CommonGenerateOptions & {
      model?: string; aspectRatio?: string; duration?: string; resolution?: string; image?: string; endImage?: string; audio: boolean; bitrateMode?: string; bitrate?: string; task?: string;
      refImage?: string[]; refVideo?: string[]; refVideoTrim?: string[]; refAudio?: string[];
    }) => {
      const client = await createClient();
      // Local paths are uploaded first — the API only takes URLs.
      const resolveAll = async (entries?: string[]) =>
        entries && entries.length > 0
          ? await Promise.all(entries.map(async (entry) => (await resolveMediaInput(client, entry)).url))
          : undefined;

      const imageUrl = opts.image ? (await resolveMediaInput(client, opts.image)).url : undefined;
      const endImageUrl = opts.endImage ? (await resolveMediaInput(client, opts.endImage)).url : undefined;

      // The end frame is where an image-to-video clip lands — without a start
      // frame there is nothing to interpolate from. Fail before spending credits.
      if (endImageUrl && !imageUrl) {
        throw new CliError(
          '--end-image is the LAST frame of an image-to-video clip. Pair it with --image.',
          'missing_start_frame'
        );
      }
      const [referenceImageUrls, referenceVideoUrls, referenceAudioUrls] = await Promise.all([
        resolveAll(opts.refImage),
        resolveAll(opts.refVideo),
        resolveAll(opts.refAudio),
      ]);

      // --ref-video-trim N:START-END → { index, start, end }. Parsed here so a
      // typo fails before any credits are spent.
      const referenceVideoTrims = (opts.refVideoTrim ?? []).map((spec) => {
        const m = /^(\d+):(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(spec.trim());
        if (!m) {
          throw new CliError(`--ref-video-trim "${spec}" must look like N:START-END (e.g. 1:3-8).`, 'invalid_reference_video_trim');
        }
        const index = Number(m[1]);
        const start = Number(m[2]);
        const end = Number(m[3]);
        if (!referenceVideoUrls || index >= referenceVideoUrls.length) {
          throw new CliError(`--ref-video-trim ${spec}: there is no --ref-video #${index} (0-based).`, 'invalid_reference_video_trim');
        }
        if (end <= start) {
          throw new CliError(`--ref-video-trim ${spec}: END must be after START.`, 'invalid_reference_video_trim');
        }
        return { index, start, end };
      });

      // fal rejects an audio-only reference set; fail before spending credits.
      if (referenceAudioUrls?.length && !referenceImageUrls?.length && !referenceVideoUrls?.length) {
        throw new CliError(
          '--ref-audio cannot be the only reference. Add at least one --ref-image or --ref-video.',
          'invalid_reference_audio'
        );
      }

      // Genfire Gedi. Checked here so a typo, or an edit with nothing to edit,
      // costs a message rather than a round trip and a reservation.
      const bitrateMode = opts.bitrate ?? opts.bitrateMode;
      if (bitrateMode && bitrateMode !== 'standard' && bitrateMode !== 'high') {
        throw new CliError('--bitrate must be standard or high.', 'invalid_bitrate_mode');
      }
      const task = opts.task?.trim().toLowerCase();
      if (task && !['reference', 'editing', 'extension'].includes(task)) {
        throw new CliError('--task must be reference, editing or extension.', 'invalid_task');
      }
      if ((task === 'editing' || task === 'extension') && !referenceVideoUrls?.length) {
        throw new CliError(
          `--task ${task} works on an existing clip. Pass it with --ref-video (and cite it as @Video1 in the prompt).`,
          'task_requires_reference_video'
        );
      }

      const run = await client.createVideoGeneration(
        {
          prompt,
          model: opts.model,
          aspect_ratio: opts.aspectRatio,
          duration: opts.duration ? Number(opts.duration) : undefined,
          resolution: opts.resolution,
          image_url: imageUrl,
          end_image_url: endImageUrl,
          reference_image_urls: referenceImageUrls,
          reference_video_urls: referenceVideoUrls,
          // Typed in @genfire/sdk from the release that adds reference_video_trims;
          // the API accepts it today, so pass it through ahead of the type bump.
          ...(referenceVideoTrims.length > 0 ? ({ reference_video_trims: referenceVideoTrims } as Record<string, unknown>) : {}),
          reference_audio_urls: referenceAudioUrls,
          generate_audio: opts.audio === false ? false : undefined,
          bitrate_mode: bitrateMode as ('standard' | 'high' | undefined),
          // Typed in @genfire/sdk from the release that adds `task`; the API
          // accepts it today, so pass it through ahead of the type bump.
          ...(task ? ({ task } as Record<string, unknown>) : {}),
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'video', opts);
    });

  // ---- speech ----
  commonOptions(
    generate
      .command('speech <text>')
      .description('Synthesize speech from text')
  , { fileable: true })
    .option('--voice-id <id>', 'Voice id to use (required for ElevenLabs models; for speech.seed_audio_1_0 pass a Seed preset name or omit)')
    .option('-m, --model <model>', 'Speech model alias')
    .option('--voice-name <name>', 'Optional friendly voice name for logs')
    .option('--format <format>', 'Output format, e.g. mp3_44100_128 (Seed Audio: wav|mp3|pcm|ogg_opus)')
    .option('--audio-url <url...>', 'Reference audio URL(s), up to 3 — reference in the text as @Audio1–@Audio3 (Seed Audio 1.0 only)')
    .option('--image-url <url>', 'Reference image URL, not combinable with --audio-url (Seed Audio 1.0 only)')
    .option('--sample-rate <hz>', 'Output sample rate in Hz: 8000|16000|24000|32000|44100|48000 (Seed Audio 1.0 only)')
    .option('--speed <speed>', 'Speaking rate: ElevenLabs 0.7–1.2, Seed Audio 0.5–2')
    .option('--volume <volume>', 'Volume 0.5–2 (Seed Audio 1.0 only)')
    .option('--pitch <semitones>', 'Pitch shift in semitones -12..12 (Seed Audio 1.0 only)')
    .option('--language <code>', 'ISO 639-1 code to enforce, e.g. es (ElevenLabs Flash/Turbo/v3 only)')
    .option('--seed <n>', 'Seed for best-effort reproducibility (ElevenLabs only)')
    .option('--previous-text <text>', 'Text spoken right BEFORE this chunk — stitching context (ElevenLabs only)')
    .option('--next-text <text>', 'Text spoken right AFTER this chunk — stitching context (ElevenLabs only)')
    .option('--normalize <mode>', 'Text normalization: auto | on | off (ElevenLabs only)')
    .option('--timestamps', 'Include per-word timings in the run output (ElevenLabs only)')
    .action(async (text: string, opts: CommonGenerateOptions & {
      model?: string; voiceId?: string; voiceName?: string; format?: string;
      audioUrl?: string[]; imageUrl?: string; sampleRate?: string; speed?: string; volume?: string; pitch?: string;
      language?: string; seed?: string; previousText?: string; nextText?: string; normalize?: string; timestamps?: boolean;
    }) => {
      const client = await createClient();
      if (opts.normalize && !['auto', 'on', 'off'].includes(opts.normalize)) {
        throw new CliError('--normalize must be auto, on or off', 'invalid_option');
      }
      const run = await client.createSpeech(
        {
          text,
          voice_id: opts.voiceId,
          voice_name: opts.voiceName,
          model: opts.model,
          output_format: opts.format,
          language_code: opts.language,
          seed: opts.seed ? Number(opts.seed) : undefined,
          previous_text: opts.previousText,
          next_text: opts.nextText,
          apply_text_normalization: opts.normalize as 'auto' | 'on' | 'off' | undefined,
          with_timestamps: opts.timestamps || undefined,
          audio_urls: opts.audioUrl && opts.audioUrl.length > 0 ? opts.audioUrl.slice(0, 3) : undefined,
          image_url: opts.imageUrl,
          sample_rate: opts.sampleRate ? Number(opts.sampleRate) : undefined,
          speed: opts.speed ? Number(opts.speed) : undefined,
          volume: opts.volume ? Number(opts.volume) : undefined,
          pitch: opts.pitch ? Number(opts.pitch) : undefined,
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'speech', opts);
    });

  // ---- transcribe ----
  generate
    .command('transcribe <url>')
    .description('Transcribe audio/video to text (Whisper by default, or ElevenLabs Scribe v2 with -m transcription.elevenlabs_scribe_v2 for speaker labels, keyterms and 90+ languages). Accepts a direct audio/video URL or a YouTube URL.')
    .option('-m, --model <model>', 'Transcription model alias: transcription.whisper_v1 (default) | transcription.elevenlabs_scribe_v2')
    .option('--video', 'Treat the URL as a video source (extract audio before transcribing)')
    .option('--youtube', 'Treat the URL as a YouTube link')
    .option('--language <code>', 'Spoken language, ISO 639-1 (Scribe only; omit to auto-detect)')
    .option('--speakers <n>', 'Expected speaker count 1–32 (Scribe only)')
    .option('--no-diarize', 'Skip speaker labelling (Scribe only)')
    .option('--keyterm <term...>', 'Vocabulary to bias recognition towards (Scribe only)')
    .option('--clean', 'Drop fillers and disfluencies (Scribe only)')
    .option('--team <teamId>', 'Bill this run to a workspace credit pool instead of your own balance')
    .option('--project <projectId>', 'File the transcript against its source audio in this project')
    .option('--quote <token>', 'A quote_token from `genfire cost estimate` — charges the price you were quoted')
    .option('--wait-timeout <duration>', 'Maximum time to wait, e.g. 15m, 600s', '15m')
    .option('--wait-interval <duration>', 'Polling interval while waiting', '3s')
    .action(async (url: string, opts: {
      model?: string; video?: boolean; youtube?: boolean;
      language?: string; speakers?: string; diarize?: boolean; keyterm?: string[]; clean?: boolean;
      team?: string; project?: string; quote?: string;
      waitTimeout: string; waitInterval: string;
    }) => {
      const client = await createClient();
      const scribe = {
        language: opts.language,
        num_speakers: opts.speakers ? Number(opts.speakers) : undefined,
        diarize: opts.diarize === false ? false : undefined,
        keyterms: opts.keyterm && opts.keyterm.length > 0 ? opts.keyterm : undefined,
        no_verbatim: opts.clean || undefined
      };
      const scope = scopeFields(opts as CommonGenerateOptions);
      const body = opts.youtube
        ? { youtube_url: url, model: opts.model, ...scribe, ...scope }
        : opts.video
          ? { video_url: url, model: opts.model, ...scribe, ...scope }
          : { audio_url: url, model: opts.model, ...scribe, ...scope };

      const run = await client.createTranscription(body as any, { idempotencyKey: randomUUID() });

      process.stderr.write(`${dim(`Polling run ${run.id}...`)}\n`);
      const finished = await waitForRun(client, run.id, {
        intervalMs: parseDurationSeconds(opts.waitInterval, '--wait-interval'),
        timeoutMs: parseDurationSeconds(opts.waitTimeout, '--wait-timeout'),
        onTick: (current, elapsed) => {
          if (current.status !== 'completed' && current.status !== 'failed') {
            process.stderr.write(`${dim(`  status=${current.status} elapsed=${Math.round(elapsed / 1000)}s\r`)}`);
          }
        }
      });
      process.stderr.write('\n');

      if (finished.status !== 'completed') {
        throw new CliError(
          `Transcription run ${finished.id} ${finished.status}${finished.error ? `: ${finished.error.message}` : ''}`,
          'transcription_failed'
        );
      }

      const output = (finished.output || {}) as { text?: string };
      // Default: print the transcript text to stdout (pipe-friendly).
      // With the global --json flag, printResult emits the full run JSON
      // (text + words + segments + language).
      printResult(finished, () => {
        process.stdout.write(`${output.text || ''}\n`);
      });
    });

  // ---- music ----
  commonOptions(
    generate
      .command('music [prompt]')
      .description('Generate music from a prompt, or from a composition plan via --plan-file')
  , { fileable: true })
    .option('-m, --model <model>', 'Music model alias (music.elevenlabs_music_v1 | music.elevenlabs_music_v2 | music.lyria3_pro | music.minimax_music_3)')
    .option('-d, --duration <seconds>', 'Duration in seconds. ElevenLabs prompt mode: 3-600. MiniMax Music 3: an upper bound of 1-300 (default 60) that billing is charged on. Lyria 3 Pro ignores it')
    .option('--plan-file <path>', 'JSON file with an ElevenLabs composition plan instead of a prompt: { sections: [...] } for music_v1 or { chunks: [...] } for music_v2 (a chunks plan implies music_v2)')
    .option('--seed <n>', 'Random seed for more consistent results (with --plan-file only)')
    .option('--flex-sections', 'Let music_v1 flex section durations of a --plan-file for quality (durations are strict by default)')
    .option('--format <format>', 'Output format')
    .option('--instrumental', 'Force an instrumental (no vocals; ElevenLabs prompt mode only)')
    .option('--image-url <url>', 'Image URL used as inspiration (Lyria 3 Pro only)')
    .option('--negative-prompt <text>', 'What to exclude from the audio (Lyria 3 Pro only)')
    .option('--lyrics <text>', 'Lyrics to sing — REQUIRED for music.minimax_music_3. Each structure tag ([verse], [chorus], ...) on its own line')
    .option('--lyrics-file <path>', 'Read the lyrics from a text file instead of --lyrics')
    .option('--steps <n>', 'Flow-matching steps per 8s chunk, 1-100 (MiniMax Music 3 only)')
    .option('--guidance <n>', 'Classifier-free guidance scale, 0-20 (MiniMax Music 3 only)')
    .action(async (prompt: string | undefined, opts: CommonGenerateOptions & {
      model?: string; duration?: string; planFile?: string; seed?: string; flexSections?: boolean;
      format?: string; instrumental?: boolean; imageUrl?: string; negativePrompt?: string;
      lyrics?: string; lyricsFile?: string; steps?: string; guidance?: string;
    }) => {
      const compositionPlan = opts.planFile ? await readMusicPlanFile(opts.planFile) : undefined;
      if (!prompt && !compositionPlan) {
        throw new CliError('Provide a prompt or --plan-file.', 'missing_prompt');
      }
      if (prompt && compositionPlan) {
        throw new CliError('A prompt and --plan-file cannot be used together.', 'invalid_arguments');
      }
      if (opts.lyrics && opts.lyricsFile) {
        throw new CliError('--lyrics and --lyrics-file cannot be used together.', 'invalid_arguments');
      }
      const lyrics = opts.lyricsFile
        ? await readLyricsFile(opts.lyricsFile)
        : opts.lyrics;
      // MiniMax Music 3 sings supplied lyrics and writes none of its own —
      // fail here rather than after a round-trip to the API.
      if (opts.model === 'music.minimax_music_3' && !lyrics?.trim()) {
        throw new CliError(
          'music.minimax_music_3 requires lyrics — pass --lyrics or --lyrics-file. Use music.lyria3_pro to have the model write the words.',
          'missing_lyrics'
        );
      }
      const client = await createClient();
      const run = await client.createMusic(
        {
          prompt,
          composition_plan: compositionPlan,
          model: opts.model,
          duration_seconds: opts.duration ? Number(opts.duration) : undefined,
          seed: opts.seed ? Number(opts.seed) : undefined,
          respect_sections_durations: opts.flexSections ? false : undefined,
          output_format: opts.format,
          force_instrumental: opts.instrumental,
          image_url: opts.imageUrl,
          negative_prompt: opts.negativePrompt,
          lyrics: lyrics?.trim() || undefined,
          num_inference_steps: opts.steps ? Number(opts.steps) : undefined,
          guidance_scale: opts.guidance ? Number(opts.guidance) : undefined,
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'music', opts);
    });

  // ---- sfx ----
  commonOptions(
    generate
      .command('sfx <prompt>')
      .description('Generate a sound effect from a prompt')
  , { fileable: true })
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
          loop: opts.loop,
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'sfx', opts);
    });

  // ---- lipsync ----
  commonOptions(
    generate
      .command('lipsync')
      .description('Lip-sync a video to an audio track')
  , { fileable: true })
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
          duration: opts.duration ? Number(opts.duration) : undefined,
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'lipsync', opts);
    });

  // ---- 3D model ----
  commonOptions(
    generate
      .command('3d')
      .description('Generate a 3D mesh (GLB) from one image, or 1–4 images of the same object from different angles')
  )
    .requiredOption('--image <urlOrPath...>', 'Source image(s), 1–4 of the SAME object. URL or local path (auto-uploaded)')
    .option('-m, --model <model>', 'model_3d_generation alias (see: genfire models list)')
    .option('--no-texture', 'Skip texture generation')
    .option('--pbr', 'Generate physically-based rendering maps')
    .option('--rigging', 'Produce a rigged skeleton')
    .option('--animation', 'Animate the rigged mesh (requires --rigging)')
    .option('--animation-action-id <id>', 'Animation library action, 0–696 (requires --animation)')
    .option('--rigging-height <meters>', 'Real-world height in metres for a rigged mesh')
    .option('--topology <type>', 'quad | triangle')
    .option('--target-polycount <count>', 'Target poly count, 100–300000')
    .option('--model-type <type>', 'standard | lowpoly')
    .option('--ultra', 'Higher-fidelity geometry with finer surface detail (Meshy v7, single image only)')
    .option('--remesh', 'Remesh the generated geometry')
    .option('--pose-mode <mode>', 'a-pose | t-pose')
    .option('--symmetry <mode>', 'off | auto | on')
    .option('--texture-prompt <text>', 'Steer texturing (with textures enabled)')
    .action(async (opts: CommonGenerateOptions & {
      image: string[]; model?: string; texture: boolean; pbr?: boolean; rigging?: boolean;
      animation?: boolean; animationActionId?: string; riggingHeight?: string; topology?: string;
      targetPolycount?: string; modelType?: string; ultra?: boolean; remesh?: boolean; poseMode?: string;
      symmetry?: string; texturePrompt?: string;
    }) => {
      if (opts.image.length > 4) {
        throw new CliError('--image accepts at most 4 images (multi-image-to-3D).', 'too_many_images');
      }
      if (opts.animation && !opts.rigging) {
        throw new CliError('--animation requires --rigging.', 'animation_requires_rigging');
      }
      if (opts.topology && opts.topology !== 'quad' && opts.topology !== 'triangle') {
        throw new CliError(`Invalid --topology: ${opts.topology}. Use quad or triangle.`, 'invalid_topology');
      }
      if (opts.modelType && opts.modelType !== 'standard' && opts.modelType !== 'lowpoly') {
        throw new CliError(`Invalid --model-type: ${opts.modelType}. Use standard or lowpoly.`, 'invalid_model_type');
      }
      if (opts.poseMode && opts.poseMode !== 'a-pose' && opts.poseMode !== 't-pose') {
        throw new CliError(`Invalid --pose-mode: ${opts.poseMode}. Use a-pose or t-pose.`, 'invalid_pose_mode');
      }
      if (opts.symmetry && !['off', 'auto', 'on'].includes(opts.symmetry)) {
        throw new CliError(`Invalid --symmetry: ${opts.symmetry}. Use off, auto, or on.`, 'invalid_symmetry');
      }

      const polycount = opts.targetPolycount === undefined ? undefined : Number(opts.targetPolycount);
      if (polycount !== undefined && (!Number.isInteger(polycount) || polycount < 100 || polycount > 300000)) {
        throw new CliError('--target-polycount must be an integer between 100 and 300000.', 'invalid_target_polycount');
      }
      const actionId = opts.animationActionId === undefined ? undefined : Number(opts.animationActionId);
      if (actionId !== undefined && (!Number.isInteger(actionId) || actionId < 0 || actionId > 696)) {
        throw new CliError('--animation-action-id must be an integer between 0 and 696.', 'invalid_animation_action_id');
      }
      const riggingHeight = opts.riggingHeight === undefined ? undefined : Number(opts.riggingHeight);
      if (riggingHeight !== undefined && (!Number.isFinite(riggingHeight) || riggingHeight <= 0)) {
        throw new CliError('--rigging-height must be a positive number.', 'invalid_rigging_height');
      }

      const client = await createClient();
      const imageUrls: string[] = [];
      for (const image of opts.image) {
        imageUrls.push((await resolveMediaInput(client, image)).url);
      }

      const run = await client.create3dModelGeneration(
        {
          image_url: imageUrls.length === 1 ? imageUrls[0] : undefined,
          image_urls: imageUrls.length > 1 ? imageUrls : undefined,
          model: opts.model,
          should_texture: opts.texture,
          enable_pbr: opts.pbr,
          enable_rigging: opts.rigging,
          enable_animation: opts.animation,
          animation_action_id: actionId,
          rigging_height_meters: riggingHeight,
          topology: opts.topology as ('quad' | 'triangle') | undefined,
          target_polycount: polycount,
          model_type: opts.modelType as ('standard' | 'lowpoly') | undefined,
          ultra_mode: opts.ultra,
          should_remesh: opts.remesh,
          pose_mode: opts.poseMode as ('a-pose' | 't-pose') | undefined,
          symmetry_mode: opts.symmetry as ('off' | 'auto' | 'on') | undefined,
          texture_prompt: opts.texturePrompt,
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, '3d-model', opts);
    });

  // ---- upscale image ----
  commonOptions(
    generate
      .command('upscale-image')
      .description('Upscale an image 2× or 4× (Topaz)')
  )
    .requiredOption('--image <urlOrPath>', 'Source image URL or local path (auto-uploaded)')
    .option('-s, --scale <factor>', 'Scale factor: 2 or 4', '2')
    .action(async (opts: CommonGenerateOptions & { image: string; scale: string }) => {
      const scale = Number(opts.scale);
      if (scale !== 2 && scale !== 4) {
        throw new CliError(`Invalid --scale: ${opts.scale}. Use 2 or 4.`, 'invalid_scale_factor');
      }
      const client = await createClient();
      const sourceImageUrl = (await resolveMediaInput(client, opts.image)).url;
      const run = await client.upscaleImage(
        { source_image_url: sourceImageUrl, scale_factor: scale, ...scopeFields(opts) } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'upscaled', opts);
    });

  // ---- upscale video ----
  commonOptions(
    generate
      .command('upscale-video')
      .description('Upscale a video — Topaz 2×/4× (default) or Flux 1.5×–3×')
  )
    .requiredOption('--video <urlOrPath>', 'Source video URL or local path (auto-uploaded)')
    .option('-s, --scale <factor>', 'Scale factor: 2 or 4 (Topaz), 1.5–3 (Flux)', '2')
    .option('-e, --engine <engine>', 'Engine: topaz or flux', 'topaz')
    .option('--mode <mode>', 'Flux only: precise or creative', 'creative')
    .option('--prompt <text>', 'Flux only: guides the creative pass')
    .action(async (opts: CommonGenerateOptions & { video: string; scale: string; engine: string; mode: string; prompt?: string }) => {
      const engine = String(opts.engine || 'topaz').toLowerCase();
      if (engine !== 'topaz' && engine !== 'flux') {
        throw new CliError(`Invalid --engine: ${opts.engine}. Use topaz or flux.`, 'invalid_engine');
      }
      const scale = Number(opts.scale);
      // Each engine validates only its own range — Flux takes a float, Topaz
      // the integer pair the command has always accepted.
      if (engine === 'flux') {
        if (!Number.isFinite(scale) || scale < 1.5 || scale > 3) {
          throw new CliError(`Invalid --scale: ${opts.scale}. Flux accepts 1.5–3.`, 'invalid_scale_factor');
        }
        if (opts.mode !== 'precise' && opts.mode !== 'creative') {
          throw new CliError(`Invalid --mode: ${opts.mode}. Use precise or creative.`, 'invalid_mode');
        }
      } else if (scale !== 2 && scale !== 4) {
        throw new CliError(`Invalid --scale: ${opts.scale}. Use 2 or 4.`, 'invalid_scale_factor');
      }
      const client = await createClient();
      const sourceVideoUrl = (await resolveMediaInput(client, opts.video)).url;
      const run = await client.upscaleVideo(
        {
          source_video_url: sourceVideoUrl,
          scale_factor: scale,
          ...(engine === 'flux'
            ? {
                model: 'video_upscale.flux_video_upscale' as const,
                mode: opts.mode as 'precise' | 'creative',
                ...(opts.prompt ? { prompt: opts.prompt } : {}),
              }
            : {}),
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'upscaled', opts);
    });

  // ---- remove background ----
  commonOptions(
    generate
      .command('remove-bg')
      .description('Cut the background out of an image (BRIA)')
  , { fileable: true })
    .requiredOption('--image <urlOrPath>', 'Source image URL or local path (auto-uploaded)')
    .action(async (opts: CommonGenerateOptions & { image: string }) => {
      const client = await createClient();
      const imageUrl = (await resolveMediaInput(client, opts.image)).url;
      const run = await client.removeBackground(
        { image_url: imageUrl, ...scopeFields(opts) } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'cutout', opts);
    });

  // ---- faceless reel ----
  // Reels are a multi-minute pipeline, so default the wait window higher than
  // the shared 15m (commonOptions sets it; we override the default below).
  {
    const reel = commonOptions(
      generate
        .command('faceless-reel <topic>')
        .description('Generate a vertical (9:16) faceless reel: script → voiceover → style-locked images → music → captioned video')
    )
      .option('-p, --preset <id>', 'Niche preset id (see: genfire faceless-reels presets)')
      .option('-s, --style <id>', 'Visual style id (see: genfire faceless-reels styles)')
      .option('-d, --duration <seconds>', 'Target length in seconds (10–600, up to 10 minutes)')
      .option('-c, --caption-preset <id>', 'Caption preset id (see: genfire faceless-reels caption-presets)')
      .option('--caption-animation <name>', 'highlight | pop | typewriter | classic | background')
      .option('--voice-id <id>', 'TTS voice id')
      .option('--vibe <mode>', 'Camera-motion feel: auto | calm | dynamic | energetic', 'auto')
      .option('--animated-hook', 'Premium: animate the first scene with a real video clip')
      .option('--video-model <m>', 'i2v model for the animated hook: grok | seedance-mini', 'grok')
      .option('--direction <text>', 'Extra creative direction for the script')
      .option('--music-source <source>', 'none | preset | ai | library', 'none')
      .option('--music-preset <id>', 'Music preset id (with --music-source preset)')
      .option('--music-prompt <text>', 'Prompt for an AI-generated track (with --music-source ai)');
    // Reels render in minutes — bump the default wait window.
    const wt = reel.options.find((o) => o.long === '--wait-timeout');
    if (wt) wt.defaultValue = '20m';
    reel.action(async (topic: string, opts: CommonGenerateOptions & {
      preset?: string; style?: string; duration?: string; captionPreset?: string; captionAnimation?: string;
      voiceId?: string; vibe?: string; animatedHook?: boolean; videoModel?: string; direction?: string; musicSource?: string; musicPreset?: string; musicPrompt?: string;
    }) => {
      const client = await createClient();
      const music = opts.musicSource && opts.musicSource !== 'none'
        ? {
            source: opts.musicSource as 'none' | 'preset' | 'ai' | 'library',
            preset_id: opts.musicPreset,
            prompt: opts.musicPrompt
          }
        : undefined;
      const run = await client.createFacelessReel(
        {
          topic,
          preset_id: opts.preset,
          style_id: opts.style,
          target_duration_sec: opts.duration ? Number(opts.duration) : undefined,
          caption_preset_id: opts.captionPreset,
          caption_animation: opts.captionAnimation,
          voice_id: opts.voiceId,
          motion_vibe: opts.vibe as ('auto' | 'calm' | 'dynamic' | 'energetic') | undefined,
          animated_hook: opts.animatedHook,
          video_model: opts.videoModel as ('grok' | 'seedance-mini') | undefined,
          direction: opts.direction,
          music,
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'faceless-reel', opts);
    });
  }

  // ---- explainer ----
  // Explainer films run 20s–10min with per-scene video clips, so renders can
  // take up to ~30 minutes — default the wait window to 45m (same pattern as
  // the faceless-reel override above).
  {
    const explainer = commonOptions(
      generate
        .command('explainer <topic>')
        .description('Generate an explainer film (20s–10min, 16:9 or 9:16): script → voiceover → style-locked frames → per-scene video clips → composed film')
    , { fileable: true })
      .option('-s, --style <id>', 'Visual style id (see: genfire explainers styles)')
      .option('-a, --aspect-ratio <ar>', 'Aspect ratio: 16:9 (default) or 9:16')
      .option('-d, --duration <seconds>', 'Target length in seconds (20–600); ignored with --script-file')
      .option('--voice-id <id>', 'TTS voice id')
      .option('--motion-level <level>', 'How many scenes get real video clips: full | mixed | stills')
      .option('--continuity <mode>', 'How animated scenes join: seamless (default, continuous footage) | cuts (scene by scene)')
      .option('--allow-duplicate', 'Render an authored script even if it re-tells an episode you already made')
      .option('--music-source <source>', 'none | preset | ai | library', 'none')
      .option('--music-preset <id>', 'Music preset id (with --music-source preset)')
      .option('--music-prompt <text>', 'Prompt for an AI-generated track (with --music-source ai)')
      .option('--caption-preset <id>', 'Caption preset id — captions are opt-in for explainers (see: genfire faceless-reels caption-presets)')
      .option('--caption-position <pos>', 'Caption placement: top | middle | bottom')
      .option('--caption-mode <mode>', 'full (every word) | keywords (emphasis pops only)')
      .option(
        '--ref <url[|label]>',
        'Reference image URL with an optional |label, e.g. --ref "https://…/logo.png|brand logo" (repeat for up to 8; beats cite them 1-based via refs)',
        (value: string, previous: string[]) => previous.concat([value]),
        [] as string[]
      )
      .option('--script-file <path>', 'JSON file with a structured script ({ cast?, beats: [...] }) — authors every beat yourself; Genfire makes zero LLM calls')
      .option('--custom-script-file <path>', 'Plain-text file narrated verbatim (Genfire still storyboards the visuals)');
    // Explainers render in tens of minutes — bump the default wait window.
    const ewt = explainer.options.find((o) => o.long === '--wait-timeout');
    if (ewt) ewt.defaultValue = '45m';
    explainer.action(async (topic: string, opts: CommonGenerateOptions & {
      style?: string; aspectRatio?: string; duration?: string; voiceId?: string; motionLevel?: string;
      continuity?: string; allowDuplicate?: boolean;
      musicSource?: string; musicPreset?: string; musicPrompt?: string;
      captionPreset?: string; captionPosition?: string; captionMode?: string;
      ref?: string[]; scriptFile?: string; customScriptFile?: string;
    }) => {
      const client = await createClient();

      const script = opts.scriptFile ? await readExplainerScriptFile(opts.scriptFile) : undefined;

      let customScript: string | undefined;
      if (opts.customScriptFile) {
        const { readFile } = await import('node:fs/promises');
        try {
          customScript = await readFile(opts.customScriptFile, 'utf8');
        } catch (err) {
          throw new CliError(
            `Could not read --custom-script-file ${opts.customScriptFile}: ${(err as Error).message}`,
            'invalid_custom_script_file'
          );
        }
      }

      const refs = opts.ref ?? [];
      if (refs.length > 8) {
        throw new CliError('At most 8 --ref reference images are allowed', 'too_many_refs');
      }
      const referenceImages = refs.length > 0
        ? refs.map((entry) => {
            const pipe = entry.indexOf('|');
            if (pipe === -1) return { url: entry.trim() };
            const label = entry.slice(pipe + 1).trim();
            return { url: entry.slice(0, pipe).trim(), ...(label ? { label } : {}) };
          })
        : undefined;

      const music = opts.musicSource && opts.musicSource !== 'none'
        ? {
            source: opts.musicSource as 'none' | 'preset' | 'ai' | 'library',
            preset_id: opts.musicPreset,
            prompt: opts.musicPrompt
          }
        : undefined;

      const run = await client.createExplainer(
        {
          topic,
          script,
          custom_script: customScript,
          style_id: opts.style,
          aspect_ratio: opts.aspectRatio as ('16:9' | '9:16') | undefined,
          target_duration_sec: opts.duration ? Number(opts.duration) : undefined,
          voice_id: opts.voiceId,
          motion_level: opts.motionLevel as ('full' | 'mixed' | 'stills') | undefined,
          continuity: opts.continuity as ('seamless' | 'cuts') | undefined,
          ...(opts.allowDuplicate ? { allow_duplicate: true } : {}),
          music,
          caption_preset_id: opts.captionPreset,
          caption_position: opts.captionPosition as ('top' | 'middle' | 'bottom') | undefined,
          caption_mode: opts.captionMode as ('full' | 'keywords') | undefined,
          reference_images: referenceImages,
          ...scopeFields(opts)
        } as any,
        { idempotencyKey: randomUUID() }
      );
      await maybeFinish(client, run.id, 'explainer', opts);
    });
  }

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
