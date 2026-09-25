import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { CliError } from './errors.js';

/**
 * ONE flag set and ONE body builder per generation kind, shared by
 * `genfire generate <kind>` and `genfire cost <kind>`.
 *
 * Why shared: the API signs a `quote_token` over a fingerprint of the RAW
 * request body (backend PublicApiQuoteService.quoteInputsFor) and the submit
 * re-derives it from its own raw body — so a quote is only spendable when both
 * bodies carry the same price inputs, spelled the same way. Before this module
 * the two commands built their bodies separately and drifted:
 *   - `cost image` omitted `count` unless -n was passed, while `generate image`
 *     always sent `count: 1` → every default quote 409'd `quote_mismatch`;
 *   - `cost video` sent `generate_audio: true` by default (commander's
 *     `--no-audio` default), `generate video` sent nothing → same 409;
 *   - `cost video` could not express a reference video / source video / task /
 *     first-last frame / keyframes / LoRA at all, so it quoted the wrong
 *     endpoint (t2v rate for a Gedi edit).
 * Building both bodies here makes "quote === charge" a property of the code
 * rather than of the user remembering to pass identical flags.
 *
 * Media inputs are resolved through an injected `resolveMedia` so the builders
 * stay pure and testable (the CLI passes resolveMediaInput, which uploads a
 * local path and resolves a `run_…` id to that run's output URL).
 */

export type MediaResolver = (input: string) => Promise<string>;

export const collect = (value: string, previous: string[] = []): string[] => previous.concat([value]);

function num(value: string | undefined, flag: string, opts: { int?: boolean; min?: number; max?: number } = {}): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || (opts.int && !Number.isInteger(n))) {
    throw new CliError(`${flag} must be ${opts.int ? 'an integer' : 'a number'} (got "${value}").`, 'invalid_option');
  }
  if ((opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) {
    throw new CliError(`${flag} must be between ${opts.min} and ${opts.max} (got ${n}).`, 'invalid_option');
  }
  return n;
}

function oneOf(value: string | undefined, allowed: readonly string[], flag: string): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (!allowed.includes(v)) {
    throw new CliError(`${flag} must be one of: ${allowed.join(', ')} (got "${value}").`, 'invalid_option');
  }
  return v;
}

async function readJsonFile(path: string, flag: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new CliError(`Could not read ${flag} ${path}: ${(err as Error).message}`, 'invalid_option');
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`${flag} ${path} is not valid JSON: ${(err as Error).message}`, 'invalid_option');
  }
}

/** `id` or `id:scale` → `{ id, scale? }` (trained image styles / video LoRAs). */
export function parseLoraSpecs(specs: string[] | undefined, flag: string, max: number): Array<{ id: string; scale?: number }> | undefined {
  if (!specs || specs.length === 0) return undefined;
  if (specs.length > max) {
    throw new CliError(`${flag} accepts at most ${max} entries.`, 'invalid_option');
  }
  return specs.map((spec) => {
    const idx = spec.lastIndexOf(':');
    if (idx === -1) return { id: spec.trim() };
    const id = spec.slice(0, idx).trim();
    const scale = num(spec.slice(idx + 1).trim(), `${flag} ${spec} scale`);
    if (!id) throw new CliError(`${flag} "${spec}" must look like ID or ID:SCALE.`, 'invalid_option');
    return { id, scale };
  });
}

/** Undefined-valued keys dropped, so a body carries only what the user set. */
function compact<T extends Record<string, unknown>>(body: T): T {
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}

// ─── Marketing Studio + brand grounding (image AND video) ────────────────────

export interface GroundingFlags {
  brand?: string;
  template?: string;
  adFormat?: string;
  hook?: string;
  setting?: string;
  product?: string;
  productImage?: string;
  avatar?: string;
  avatarImage?: string;
}

export function addGroundingOptions(cmd: Command): Command {
  return cmd
    .option('--brand <brandId>', 'Ground on a brand: its product photos become references and its colors/voice prefix the prompt (see: genfire brands list)')
    .option('--template <templateId>', 'Recreate a Marketing Studio AD TEMPLATE; supplies its own model, framing, resolution and (video) duration unless you override them. A prompt becomes the CHANGE to the template')
    .option('--ad-format <formatId>', 'Marketing genre (unboxing, tutorial, before-after…) — marketing_format_id')
    .option('--hook <hookId>', 'Marketing opening mechanic — marketing_hook_id')
    .option('--setting <settingId>', 'Marketing environment — marketing_setting_id')
    .option('--product <productId>', "Fill the template's PRODUCT slot from your stored brand products")
    .option('--product-image <urlOrPath>', "Fill the template's PRODUCT slot with a photo (URL, local path or run id)")
    .option('--avatar <avatarId>', "Fill the template's AVATAR slot (e.g. influencer:abc or preset:xyz)")
    .option('--avatar-image <urlOrPath>', "Fill the template's AVATAR slot with a photo (URL, local path or run id)");
}

async function buildGrounding(opts: GroundingFlags, resolveMedia: MediaResolver): Promise<Record<string, unknown>> {
  return compact({
    brand_id: opts.brand,
    marketing_template_id: opts.template,
    marketing_format_id: opts.adFormat,
    marketing_hook_id: opts.hook,
    marketing_setting_id: opts.setting,
    product_id: opts.product,
    product_image_url: opts.productImage ? await resolveMedia(opts.productImage) : undefined,
    avatar_id: opts.avatar,
    avatar_image_url: opts.avatarImage ? await resolveMedia(opts.avatarImage) : undefined
  });
}

// ─── Image ───────────────────────────────────────────────────────────────────

export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;
const MOODBOARD_STRENGTHS = ['subtle', 'balanced', 'strong'] as const;
const Z_IMAGE_CONTROL_MODES = ['none', 'canny', 'depth', 'pose'] as const;
const Z_IMAGE_TILING_MODES = ['both', 'horizontal', 'vertical'] as const;

export interface ImageFlags extends GroundingFlags {
  model?: string;
  aspectRatio?: string;
  count?: string;
  image?: string[];
  mask?: string;
  quality?: string;
  resolution?: string;
  moodboard?: string;
  moodboardStrength?: string;
  imageStyle?: string[];
  strength?: string;
  negativePrompt?: string;
  controlMode?: string;
  controlScale?: string;
  tilingMode?: string;
}

export function addImageRequestOptions(cmd: Command): Command {
  cmd
    .option('-m, --model <model>', 'Public model alias, e.g. image.nano_banana_2 (default: the API default image model)')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio, e.g. 1:1, 16:9')
    .option('-n, --count <n>', 'Number of images (1-4)', '1')
    .option(
      '-i, --image <urlOrPath>',
      'Source/reference image: URL, local path (auto-uploaded) or a completed run id. Repeat for a multi-image edit (up to 14; GPT Image 2 / Seedream / Qwen / Nano Banana — Grok uses the first 3)',
      collect,
      [] as string[]
    )
    .option('--mask <urlOrPath>', 'Inpaint mask (white = repaint, black = keep), same size as the source. Needs -i. Models with capabilities.masked_inpaint only')
    .option('-q, --quality <level>', 'Quality tier: low, medium, high, auto (image.gpt_image_2) — image.grok_imagine_2 takes low or medium')
    .option('-r, --resolution <res>', 'Output resolution: 1K, 2K, 4K (image.grok_imagine_pro / image.grok_imagine_2 = 1K or 2K; nano-banana family edit only — supply -i or @<handle>)')
    .option('--moodboard <moodboardId>', 'Style the image after one of your moodboards (see: genfire moodboards list)')
    .option('--moodboard-strength <level>', `How hard the moodboard steers: ${MOODBOARD_STRENGTHS.join(', ')}`)
    .option('--image-style <id[:scale]>', 'Trained image style (LoRA) from `genfire image-styles list`, optional :scale. Repeat for up to 3. Required by image.flux_lora; also read by the Z-Image Turbo models', collect, [] as string[])
    .option('--strength <0-1>', 'Image-to-image strength (image.z_image_turbo / image.z_image_tiling with -i only)')
    .option('--negative-prompt <text>', 'What to keep out of the image (image.z_image_base only)')
    .option('--control-mode <mode>', `ControlNet guide: ${Z_IMAGE_CONTROL_MODES.join(', ')} (image.z_image_controlnet only)`)
    .option('--control-scale <0-1>', 'ControlNet strength (image.z_image_controlnet only)')
    .option('--tiling-mode <mode>', `Seamless tiling axis: ${Z_IMAGE_TILING_MODES.join(', ')} (image.z_image_tiling only)`);
  return addGroundingOptions(cmd);
}

/** Validation that needs no network — runs before any upload. */
export function validateImageFlags(opts: ImageFlags): void {
  const count = num(opts.count ?? '1', '--count', { int: true, min: 1, max: 4 });
  void count;
  if ((opts.image?.length ?? 0) > 14) {
    throw new CliError('At most 14 -i/--image inputs are allowed for a multi-image edit', 'too_many_images');
  }
  if (opts.quality && !(IMAGE_QUALITIES as readonly string[]).includes(opts.quality)) {
    throw new CliError(`--quality must be one of: ${IMAGE_QUALITIES.join(', ')}`, 'invalid_quality');
  }
  if (opts.resolution && !(IMAGE_RESOLUTIONS as readonly string[]).includes(opts.resolution)) {
    throw new CliError(`--resolution must be one of: ${IMAGE_RESOLUTIONS.join(', ')}`, 'invalid_resolution');
  }
  if (opts.mask && !(opts.image && opts.image.length > 0)) {
    throw new CliError('--mask repaints part of a source image — pass the source with -i.', 'mask_requires_image');
  }
  if (opts.moodboardStrength && !opts.moodboard) {
    throw new CliError('--moodboard-strength needs --moodboard.', 'invalid_option');
  }
  oneOf(opts.moodboardStrength, MOODBOARD_STRENGTHS, '--moodboard-strength');
  oneOf(opts.controlMode, Z_IMAGE_CONTROL_MODES, '--control-mode');
  oneOf(opts.tilingMode, Z_IMAGE_TILING_MODES, '--tiling-mode');
  num(opts.strength, '--strength', { min: 0, max: 1 });
  num(opts.controlScale, '--control-scale', { min: 0, max: 1 });
  parseLoraSpecs(opts.imageStyle, '--image-style', 3);
}

/**
 * The `/v1/images/generations` body (minus `prompt`, `mentions` and the
 * run-scoping fields, which the generate command adds). The same object is
 * what `genfire cost image` posts to /v1/models/estimate-cost.
 */
export async function buildImageRequest(opts: ImageFlags, resolveMedia: MediaResolver): Promise<Record<string, unknown>> {
  validateImageFlags(opts);
  const urls: string[] = [];
  for (const input of opts.image ?? []) urls.push(await resolveMedia(input));
  return compact({
    model: opts.model,
    aspect_ratio: opts.aspectRatio,
    // ALWAYS sent (default 1): the quote fingerprint keys `count`, so a body
    // that omits it hashes differently from one that says 1.
    count: num(opts.count ?? '1', '--count', { int: true }),
    image_url: urls.length === 1 ? urls[0] : undefined,
    image_urls: urls.length > 1 ? urls : undefined,
    mask_url: opts.mask ? await resolveMedia(opts.mask) : undefined,
    quality: opts.quality,
    resolution: opts.resolution,
    moodboard_id: opts.moodboard,
    moodboard_strength: opts.moodboardStrength?.trim().toLowerCase(),
    loras: parseLoraSpecs(opts.imageStyle, '--image-style', 3),
    strength: num(opts.strength, '--strength'),
    negative_prompt: opts.negativePrompt,
    control_mode: opts.controlMode?.trim().toLowerCase(),
    control_scale: num(opts.controlScale, '--control-scale'),
    tiling_mode: opts.tilingMode?.trim().toLowerCase(),
    ...(await buildGrounding(opts, resolveMedia))
  });
}

// ─── Video ───────────────────────────────────────────────────────────────────

// H3 Max Styles — mirrored from backend/src/lib/models/h3MaxStyles.ts
// (H3_MAX_STYLE_IDS / H3_MAX_DAMAGE_LEVELS / H3_MAX_STYLES_PUBLIC_ALIAS),
// which this package cannot import. The API stays the validator of record.
export const H3_MAX_STYLES_ALIAS = 'video.hailuo_03_max_styles';
export const H3_MAX_STYLE_IDS = ['vhs', 'retro_toon_70s', 'low_poly', 'hand_drawn', '16bit_pixel'] as const;
export const H3_MAX_DAMAGE_LEVELS = ['light', 'medium', 'heavy'] as const;
// backend/src/lib/cameraTrajectory.ts CAMERA_PATH_IDS.
export const CAMERA_PATH_IDS = [
  'orbit', 'orbit_reverse', 'half_orbit', 'quarter_orbit', 'dolly_in', 'dolly_out',
  'crane_up', 'low_angle', 'top_down', 'arc_push', 'spiral', 'hero_reveal'
] as const;
const VIDEO_TASKS = ['reference', 'editing', 'extension'] as const;

/** `Low Poly`, `low-poly`, `retro-toon-70s` → the canonical id, or undefined. */
export function normalizeVideoStyle(value: string): (typeof H3_MAX_STYLE_IDS)[number] | undefined {
  const id = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (H3_MAX_STYLE_IDS as readonly string[]).includes(id) ? (id as (typeof H3_MAX_STYLE_IDS)[number]) : undefined;
}

export interface VideoFlags extends GroundingFlags {
  model?: string;
  aspectRatio?: string;
  duration?: string;
  resolution?: string;
  image?: string;
  startImage?: string;
  endImage?: string;
  firstFrame?: string;
  lastFrame?: string;
  sourceVideo?: string;
  refImage?: string[];
  refVideo?: string[];
  refVideoTrim?: string[];
  refAudio?: string[];
  keyframe?: string[];
  draftCacheUrl?: string;
  fileUrl?: string;
  webUrl?: string;
  lora?: string[];
  elementsFile?: string;
  multiPrompt?: string[];
  shotType?: string;
  cameraPath?: string;
  cameraTrajectory?: string;
  /** commander's `--no-audio`: true unless negated. */
  audio?: boolean;
  bitrate?: string;
  bitrateMode?: string;
  task?: string;
  style?: string;
  damageLevel?: string;
}

export function addVideoRequestOptions(cmd: Command): Command {
  cmd
    .option('-m, --model <model>', 'Public model alias, e.g. video.veo_3_1 (default: the API default video model)')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio (16:9, 9:16, 1:1, …; see limits in `genfire models get`)')
    .option('-d, --duration <seconds>', 'Duration in seconds (model-dependent; default 5)')
    .option('-r, --resolution <resolution>', 'Output resolution, model-dependent (e.g. 480p, 720p, 1080p, 4k). Higher resolutions cost more credits.')
    .option('-i, --image <urlOrPath>', 'Start frame (image-to-video): URL, local path (auto-uploaded) or a completed run id')
    .option('--end-image <urlOrPath>', 'Last frame the clip lands on, paired with --image (or --start-image on Kling O3). Supported where capabilities.end_frame is true (Seedance, Kling V3/O3/2.6, Hailuo 03/02 Standard)')
    .option('--start-image <urlOrPath>', 'Kling O3 structured start frame (start_image_url) — use with --elements-file / --multi-prompt; other models take --image')
    .option('--first-frame <urlOrPath>', 'First frame of a first/last-frame clip (needs --last-frame; models with capabilities.first_last_frame)')
    .option('--last-frame <urlOrPath>', 'Last frame of a first/last-frame clip (needs --first-frame)')
    .option('--source-video <urlOrPath>', 'Source clip to edit / extend / restyle (video-to-video models — capabilities.source_video). Source-tracking edits bill the clip\'s measured length')
    .option('--ref-image <urlOrPath...>', 'Reference image URL(s), local paths or run ids — cite in the prompt as Image 1, Image 2, … (Hailuo 03, Wan 3.0) or @Image1, @Image2, … (Seedance). Up to 9 on most models, 10 on Wan 3.0 / Omni Flash 1.1, 30 on video.seedance_2_5')
    .option('--ref-video <urlOrPath...>', 'Reference clip URL(s) or local paths — cite as Video 1… (Hailuo 03, Wan 3.0) or @Video1… (Seedance). Up to 3 on Hailuo 03 and Seedance 2.0, 5 on Wan 3.0 (15s total), 10 on video.seedance_2_5 (each 1.8-30.2s, 30.2s TOTAL across the pool). On video.seedance_2_5 this is also the clip --task edits or transfers motion from')
    .option('--ref-video-trim <spec...>', 'Time window for a --ref-video clip, as N:START-END in seconds (0-based N), e.g. --ref-video-trim 1:3-8 uses seconds 3–8 of the second clip. Only the window is sent. Must fit the model\'s per-clip cap (3s Omni Flash 1.1, 15s Hailuo 03 / Wan 3.0, 30s Seedance)')
    .option('--ref-audio <urlOrPath...>', 'Reference audio URL(s) or local paths, 2-15s each — cite as Audio 1..Audio 3. Gives a character a consistent voice. Needs at least one --ref-image or --ref-video alongside it')
    .option('--keyframe <FRAME:urlOrPath>', 'Pin an image at a 24 fps frame index, e.g. --keyframe 0:start.png --keyframe 96:end.png (Flux 3 keyframes-to-video; capabilities.keyframes). Repeatable', collect, [] as string[])
    .option('--draft-cache-url <url>', 'Flux 3 draft-enhance: the draft_cache_url a previous /draft run returned')
    .option('--file-url <urlOrPath>', 'Document to ground the clip on (Wan 3.0 reference-to-video; turns thinking on)')
    .option('--web-url <url>', 'Web page to ground the clip on (Wan 3.0 reference-to-video; turns thinking on)')
    .option('--lora <id[:scale]>', 'Trained video model (subject LoRA) from `genfire trained-models list`, optional :scale. Repeat for up to 3 (Hailuo 03)', collect, [] as string[])
    .option('--elements-file <path>', 'Kling O3 elements: JSON array (max 3) of { frontal_image_url | video_url, reference_image_urls?, voice_id? }')
    .option('--multi-prompt <[SECONDS:]prompt>', 'Kling O3 multi-shot: one shot per flag, optional leading duration, e.g. --multi-prompt "5:she opens the door" --multi-prompt "he waves"', collect, [] as string[])
    .option('--shot-type <type>', 'Kling O3 multi-shot mode: customize | intelligent')
    .option('--camera-path <preset>', `H3 Max Multi Angle camera move: ${CAMERA_PATH_IDS.join(', ')}`)
    .option('--camera-trajectory <file>', 'H3 Max Multi Angle explicit camera path: JSON array of 2-12 { time, azimuth, elevation, distance } keyframes')
    .option('--no-audio', 'Disable audio generation if the model supports it')
    .option('--bitrate <mode>', 'Output encode quality: standard or high (high = larger, higher-quality file at no extra cost). Seedance 2.0 Standard/Fast and Seedance 2.5 only')
    .option('--bitrate-mode <mode>', 'Alias of --bitrate (kept for scripts written before --bitrate existed)')
    .option('--task <task>', 'GENFIRE GEDI, video.seedance_2_5 only: reference (motion transfer — the --ref-video supplies the motion, --ref-image supplies who performs it), editing (video edit — re-light, swap, clean up the --ref-video itself; the output follows the source, so leave -a and -d off) or extension (continue the clip). editing and extension need a --ref-video. Recipes with the prompts written for you: genfire gedi presets')
    .option('--style <style>', `H3 Max Styles look: ${H3_MAX_STYLE_IDS.join(', ')}. Runs on ${H3_MAX_STYLES_ALIAS} (picked for you when -m is omitted): 5-15s, fixed 768p with audio, one flat rate for every look. Optional --image first frame; no --end-image or references`)
    .option('--damage-level <level>', `With --style vhs only: tape wear, ${H3_MAX_DAMAGE_LEVELS.join(', ')} (default medium)`);
  return addGroundingOptions(cmd);
}

/** `N:START-END` → `{ index, start, end }`; index checked against the pool size. */
export function parseRefVideoTrims(specs: string[] | undefined, poolSize: number): Array<{ index: number; start: number; end: number }> {
  return (specs ?? []).map((spec) => {
    const m = /^(\d+):(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(spec.trim());
    if (!m) {
      throw new CliError(`--ref-video-trim "${spec}" must look like N:START-END (e.g. 1:3-8).`, 'invalid_reference_video_trim');
    }
    const index = Number(m[1]);
    const start = Number(m[2]);
    const end = Number(m[3]);
    if (index >= poolSize) {
      throw new CliError(`--ref-video-trim ${spec}: there is no --ref-video #${index} (0-based).`, 'invalid_reference_video_trim');
    }
    if (end <= start) {
      throw new CliError(`--ref-video-trim ${spec}: END must be after START.`, 'invalid_reference_video_trim');
    }
    return { index, start, end };
  });
}

/** `[SECONDS:]prompt` → `{ prompt, duration? }` (Kling O3 wants the duration as a string). */
export function parseMultiPrompt(specs: string[] | undefined): Array<{ prompt: string; duration?: string }> | undefined {
  if (!specs || specs.length === 0) return undefined;
  return specs.map((spec) => {
    const m = /^(\d{1,2})\s*:\s*([\s\S]+)$/.exec(spec);
    if (m) {
      const seconds = Number(m[1]);
      if (seconds < 1 || seconds > 15) {
        throw new CliError(`--multi-prompt "${spec}": shot duration must be 1-15 seconds.`, 'invalid_multi_prompt');
      }
      return { prompt: m[2].trim(), duration: String(seconds) };
    }
    if (!spec.trim()) throw new CliError('--multi-prompt needs a prompt.', 'invalid_multi_prompt');
    return { prompt: spec.trim() };
  });
}

/** Validation that needs no network — runs before anything is uploaded. */
export function validateVideoFlags(opts: VideoFlags): void {
  const style = opts.style !== undefined ? normalizeVideoStyle(opts.style) : undefined;
  if (opts.style !== undefined && !style) {
    throw new CliError(`--style must be one of: ${H3_MAX_STYLE_IDS.join(', ')} (got "${opts.style}").`, 'invalid_video_style');
  }
  const damage = opts.damageLevel?.trim().toLowerCase();
  if (damage !== undefined && !(H3_MAX_DAMAGE_LEVELS as readonly string[]).includes(damage)) {
    throw new CliError(`--damage-level must be one of: ${H3_MAX_DAMAGE_LEVELS.join(', ')}.`, 'invalid_damage_level');
  }
  if (damage !== undefined && style !== 'vhs') {
    throw new CliError('--damage-level is the VHS tape wear — pass it with --style vhs.', 'unsupported_damage_level');
  }
  // The end frame is where an image-to-video clip lands — without a start
  // frame there is nothing to interpolate from.
  if (opts.endImage && !opts.image && !opts.startImage) {
    throw new CliError(
      '--end-image is the LAST frame of an image-to-video clip. Pair it with --image (or --start-image on Kling O3).',
      'missing_start_frame'
    );
  }
  if (Boolean(opts.firstFrame) !== Boolean(opts.lastFrame)) {
    throw new CliError('--first-frame and --last-frame must be passed together.', 'invalid_first_last_frame');
  }
  if (opts.refAudio?.length && !opts.refImage?.length && !opts.refVideo?.length) {
    throw new CliError(
      '--ref-audio cannot be the only reference. Add at least one --ref-image or --ref-video.',
      'invalid_reference_audio'
    );
  }
  const bitrate = opts.bitrate ?? opts.bitrateMode;
  if (bitrate && bitrate !== 'standard' && bitrate !== 'high') {
    throw new CliError('--bitrate must be standard or high.', 'invalid_bitrate_mode');
  }
  const task = oneOf(opts.task, VIDEO_TASKS, '--task');
  if ((task === 'editing' || task === 'extension') && !opts.refVideo?.length) {
    throw new CliError(
      `--task ${task} works on an existing clip. Pass it with --ref-video (and cite it as @Video1 in the prompt).`,
      'task_requires_reference_video'
    );
  }
  oneOf(opts.shotType, ['customize', 'intelligent'], '--shot-type');
  oneOf(opts.cameraPath, CAMERA_PATH_IDS, '--camera-path');
  if (opts.cameraPath && opts.cameraTrajectory) {
    throw new CliError('Pass --camera-path OR --camera-trajectory, not both.', 'invalid_camera_trajectory');
  }
  num(opts.duration, '--duration', { int: true, min: 1, max: 30 });
  parseRefVideoTrims(opts.refVideoTrim, opts.refVideo?.length ?? 0);
  parseMultiPrompt(opts.multiPrompt);
  parseLoraSpecs(opts.lora, '--lora', 3);
  for (const spec of opts.keyframe ?? []) {
    if (!/^\d+:.+$/.test(spec)) {
      throw new CliError(`--keyframe "${spec}" must look like FRAME:urlOrPath (e.g. 0:start.png).`, 'invalid_keyframes');
    }
  }
}

async function resolveAll(entries: string[] | undefined, resolveMedia: MediaResolver): Promise<string[] | undefined> {
  if (!entries || entries.length === 0) return undefined;
  return Promise.all(entries.map((entry) => resolveMedia(entry)));
}

/**
 * The `/v1/videos/generations` body (minus `prompt` and the run-scoping
 * fields). `genfire cost video` posts the same object to
 * /v1/models/estimate-cost, so the routing (t2v / i2v / ref / edit / Gedi
 * video-ref) and the quote fingerprint match the real submit.
 */
export async function buildVideoRequest(opts: VideoFlags, resolveMedia: MediaResolver): Promise<Record<string, unknown>> {
  validateVideoFlags(opts);
  const style = opts.style !== undefined ? normalizeVideoStyle(opts.style) : undefined;

  const [referenceImageUrls, referenceVideoUrls, referenceAudioUrls] = await Promise.all([
    resolveAll(opts.refImage, resolveMedia),
    resolveAll(opts.refVideo, resolveMedia),
    resolveAll(opts.refAudio, resolveMedia)
  ]);
  const trims = parseRefVideoTrims(opts.refVideoTrim, referenceVideoUrls?.length ?? 0);

  const keyframes = opts.keyframe && opts.keyframe.length > 0
    ? await Promise.all(opts.keyframe.map(async (spec) => {
        const idx = spec.indexOf(':');
        return { frame_index: Number(spec.slice(0, idx)), image_url: await resolveMedia(spec.slice(idx + 1)) };
      }))
    : undefined;

  let elements: unknown;
  if (opts.elementsFile) {
    elements = await readJsonFile(opts.elementsFile, '--elements-file');
    if (!Array.isArray(elements) || elements.length === 0 || elements.length > 3) {
      throw new CliError('--elements-file must hold a JSON array of 1-3 Kling O3 element objects.', 'invalid_elements');
    }
  }
  let cameraTrajectory: unknown;
  if (opts.cameraTrajectory) {
    cameraTrajectory = await readJsonFile(opts.cameraTrajectory, '--camera-trajectory');
    if (!Array.isArray(cameraTrajectory) || cameraTrajectory.length < 2 || cameraTrajectory.length > 12) {
      throw new CliError('--camera-trajectory must hold a JSON array of 2-12 { time, azimuth, elevation, distance } keyframes.', 'invalid_camera_trajectory');
    }
  }

  const one = async (value: string | undefined) => (value ? resolveMedia(value) : undefined);
  return compact({
    // A style only has one engine; everything else keeps the API default.
    model: opts.model ?? (style ? H3_MAX_STYLES_ALIAS : undefined),
    aspect_ratio: opts.aspectRatio,
    duration: num(opts.duration, '--duration', { int: true }),
    resolution: opts.resolution,
    image_url: await one(opts.image),
    start_image_url: await one(opts.startImage),
    end_image_url: await one(opts.endImage),
    first_frame_url: await one(opts.firstFrame),
    last_frame_url: await one(opts.lastFrame),
    source_video_url: await one(opts.sourceVideo),
    reference_image_urls: referenceImageUrls,
    reference_video_urls: referenceVideoUrls,
    reference_video_trims: trims.length > 0 ? trims : undefined,
    reference_audio_urls: referenceAudioUrls,
    keyframes,
    draft_cache_url: opts.draftCacheUrl,
    file_url: await one(opts.fileUrl),
    web_url: opts.webUrl,
    loras: parseLoraSpecs(opts.lora, '--lora', 3),
    elements,
    multi_prompt: parseMultiPrompt(opts.multiPrompt),
    shot_type: opts.shotType?.trim().toLowerCase(),
    camera_path: opts.cameraPath?.trim().toLowerCase(),
    camera_trajectory: cameraTrajectory,
    // Only an explicit opt-out is sent. The API defaults to audio on, and the
    // quote fingerprint keys generate_audio only when it is a boolean — so
    // sending `true` by default made every default quote unspendable.
    generate_audio: opts.audio === false ? false : undefined,
    bitrate_mode: opts.bitrate ?? opts.bitrateMode,
    task: opts.task?.trim().toLowerCase(),
    video_style: style,
    damage_level: opts.damageLevel?.trim().toLowerCase(),
    ...(await buildGrounding(opts, resolveMedia))
  });
}

// ─── Speech ──────────────────────────────────────────────────────────────────

export interface SpeechExtraFlags {
  influencer?: string;
  dialogueFile?: string;
  stability?: string;
  voiceSettings?: string;
}

/**
 * The speech fields beyond plain text + voice: an influencer `mention`, a
 * multi-voice `dialogue`, and the ElevenLabs voice tuning. Shared with
 * `genfire cost speech` because `dialogue` changes both the price (dialogue
 * rate, characters summed across lines) and the quote fingerprint.
 */
export async function buildSpeechExtras(text: string | undefined, opts: SpeechExtraFlags): Promise<Record<string, unknown>> {
  let dialogue: Array<{ text: string; voice_id: string }> | undefined;
  if (opts.dialogueFile) {
    const parsed = await readJsonFile(opts.dialogueFile, '--dialogue-file');
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new CliError('--dialogue-file must hold a non-empty JSON array of { text, voice_id } lines.', 'invalid_dialogue');
    }
    dialogue = parsed.map((line: any, i: number) => {
      if (!line || typeof line.text !== 'string' || !line.text.trim() || typeof line.voice_id !== 'string' || !line.voice_id.trim()) {
        throw new CliError(`--dialogue-file line ${i} needs a non-empty text and voice_id.`, 'invalid_dialogue');
      }
      return { text: line.text, voice_id: line.voice_id };
    });
    if (text) {
      throw new CliError('Pass the text OR --dialogue-file, not both.', 'invalid_arguments');
    }
  } else if (!text) {
    throw new CliError('Provide the text to speak, or --dialogue-file.', 'missing_text');
  }

  let mention: { influencer_id?: string; handle?: string } | undefined;
  if (opts.influencer) {
    const value = opts.influencer.trim();
    mention = value.startsWith('@') ? { handle: value.slice(1) } : { influencer_id: value };
  }

  let voiceSettings: unknown;
  if (opts.voiceSettings) {
    try {
      voiceSettings = JSON.parse(opts.voiceSettings);
    } catch (err) {
      throw new CliError(`--voice-settings is not valid JSON: ${(err as Error).message}`, 'invalid_option');
    }
    if (!voiceSettings || typeof voiceSettings !== 'object' || Array.isArray(voiceSettings)) {
      throw new CliError('--voice-settings must be a JSON object.', 'invalid_option');
    }
  }

  return compact({
    dialogue,
    mention,
    stability: num(opts.stability, '--stability', { min: 0, max: 1 }),
    voice_settings: voiceSettings
  });
}
