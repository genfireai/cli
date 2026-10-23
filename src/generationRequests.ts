import { Command } from 'commander';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { CliError } from './errors.js';
import { ISSUED_RUN_ID } from './runHelpers.js';
import { findExtensionSibling } from './upload.js';

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
 *     endpoint (t2v rate for a Genjudo edit).
 * Building both bodies here makes "quote === charge" a property of the code
 * rather than of the user remembering to pass identical flags.
 *
 * Media inputs are resolved through an injected `resolveMedia` so the builders
 * stay pure and testable (the CLI passes resolveMediaInput, which uploads a
 * local path and resolves a `run_…` id to that run's output URL).
 */

export type MediaResolver = (input: string) => Promise<string>;

/**
 * The FREE `POST /v1/media/inspect` probe, injected the same way: Genjudo's
 * "Match the clip" sizes the run from the clip's measured length, and cost and
 * generate must measure it identically for the quote to stay spendable.
 */
export type MediaInspector = (url: string) => Promise<{ durationSeconds?: number | null; hasAudio?: boolean | null }>;

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

// ─── A prompt typed after a variadic flag ────────────────────────────────────

/**
 * `--ref-image <urlOrPath...>` (and the other `<…...>` media flags) is
 * variadic: commander hands it EVERY following word up to the next flag. So
 * `generate video -m video.seedance_2_5 --ref-video a.mov --ref-image me.jpg
 * "make her dance"` read the prompt as a second reference image — `generate
 * video` died with "missing required argument 'prompt'" and `cost video`
 * tried to upload the prompt as a file.
 *
 * When no prompt reached the positional, the LAST value of each variadic list
 * is looked at, and one that is clearly not media is taken back as the prompt
 * (`--ref-image a.jpg b.jpg` keeps working: both are files). Called by
 * generate AND cost, on the same parsed flags, so the two still build one body
 * (see the quote note at the top of this file).
 */
export const VIDEO_VARIADIC_FLAGS = ['refImage', 'refVideo', 'refAudio', 'refVideoTrim'] as const;

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a trailing variadic value is the prompt rather than media. An
 * EXISTING path — file or directory, spaces and all (`Screen Recording.mov`,
 * `My Clips`) — is always media. Anything else with whitespace is prose: no
 * URL or run id has any. A single word is the prompt unless something about
 * it says media: a URL, an issued run id (`run_…`, `dash_video_…` — NOT any
 * word with an underscore, so `slow_motion` is a prompt), a slash or an
 * extension, or an `IMG_1234.MOV` beside it.
 */
export function looksLikePrompt(value: string, exists: (path: string) => boolean = pathExists): boolean {
  if (value.trim() === '') return true;
  if (exists(value)) return false;
  if (/\s/.test(value)) return true;
  if (/^https?:\/\//i.test(value) || ISSUED_RUN_ID.test(value)) return false;
  if (/[\\/]/.test(value) || /\.[A-Za-z0-9]{1,5}$/.test(value)) return false;
  return findExtensionSibling(value) === null;
}

/**
 * The prompt, recovered from the tail of one variadic list when the positional
 * got none (the list loses that value). Undefined when no tail reads as a
 * prompt; an error when two do, since which one was meant is a guess.
 */
export function recoverTrailingPrompt(
  prompt: string | undefined,
  opts: object,
  keys: readonly string[],
  exists: (path: string) => boolean = pathExists
): string | undefined {
  if (prompt !== undefined) return prompt;
  const lists = opts as Record<string, unknown>;
  const hits = keys.filter((key) => {
    const list = lists[key];
    if (!Array.isArray(list) || list.length === 0) return false;
    const last = String(list[list.length - 1]);
    // A trim spec (`0:2-6`) is a --ref-video-trim value, never prose.
    if (key === 'refVideoTrim' && /^\s*\d+\s*:/.test(last)) return false;
    return looksLikePrompt(last, exists);
  });
  if (hits.length === 0) return undefined;
  if (hits.length > 1) {
    const values = hits.map((key) => `"${(lists[key] as string[]).at(-1)}"`).join(' and ');
    throw new CliError(
      `Both ${values} read as the prompt. Put the prompt right after the command (before the options), or after \`--\`.`,
      'ambiguous_prompt'
    );
  }
  const list = lists[hits[0]] as string[];
  const recovered = list[list.length - 1];
  lists[hits[0]] = list.length > 1 ? list.slice(0, -1) : undefined;
  return recovered;
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
// Ideogram 4.5 edits only (image.ideogram_v4_5). The API rejects it on every
// other model and without a source image, so the CLI checks the value only.
export const IMAGE_EDIT_PRECISIONS = ['regular', 'high'] as const;
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
  editPrecision?: string;
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
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio (16:9, 9:16, 1:1, …; see limits in `genfire models get`; default 16:9). A ONE-clip Genjudo run (video.seedance_2_5, exactly one --ref-video, --task reference / none or editing) defaults to auto — the clip\'s own frame, the same default the API applies')
    .option('-n, --count <n>', 'Number of images (1-4)', '1')
    .option(
      '-i, --image <urlOrPath>',
      'Source/reference image: URL, local path (auto-uploaded) or a completed run id. Repeat for a multi-image edit (up to 14; GPT Image 2 / Seedream / Qwen / Nano Banana — Grok uses the first 3; Ideogram 4.5 = the source plus up to 4 references; Ideogram Vector = up to 5 references)',
      collect,
      [] as string[]
    )
    .option('--mask <urlOrPath>', 'Inpaint mask (white = repaint, black = keep), same size as the source. Needs -i. Models with capabilities.masked_inpaint only')
    .option('-q, --quality <level>', 'Quality tier: low, medium, high, auto (image.gpt_image_2) — image.grok_imagine_2 takes low or medium; image.ideogram_v4_5 and image.ideogram_vector take low, medium or high (default medium)')
    .option('-r, --resolution <res>', 'Output resolution: 1K, 2K, 4K (image.grok_imagine_pro / image.grok_imagine_2 = 1K or 2K; image.nano_banana_2 / image.nano_banana_2_1 / image.nano_banana_pro = 1K, 2K or 4K; image.ideogram_v4_5 = 1K or 2K, default 2K, same price)')
    .option('--edit-precision <level>', `Edit precision: ${IMAGE_EDIT_PRECISIONS.join(', ')} (image.ideogram_v4_5 edits with -i only). high = Precise Edit: keeps every pixel the prompt does not name, same price`)
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
  oneOf(opts.editPrecision, IMAGE_EDIT_PRECISIONS, '--edit-precision');
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
    edit_precision: opts.editPrecision?.trim().toLowerCase(),
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

// ─── Vectorize (POST /v1/images/vectorize) ───────────────────────────────────

// Mirrored from backend/src/lib/models/ideogramVectorEndpoints.ts
// (IDEOGRAM_VECTORIZE_MODES), which this package cannot import. Same price.
export const VECTORIZE_MODES = ['default', 'simple'] as const;

export interface VectorizeFlags {
  image: string;
  mode?: string;
}

/**
 * The `/v1/images/vectorize` body (minus the run-scoping fields). `mode` is
 * sent only when given, so the API default applies otherwise.
 */
export async function buildVectorizeRequest(opts: VectorizeFlags, resolveMedia: MediaResolver): Promise<Record<string, unknown>> {
  const mode = oneOf(opts.mode, VECTORIZE_MODES, '--mode');
  return compact({
    image_url: await resolveMedia(opts.image),
    mode
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
// H3 Max Insert — mirrored from backend/src/lib/models/h3MaxInsert.ts
// (H3_MAX_INSERT_PUBLIC_ALIAS / _MIN_START_SECONDS / _MAX_TIME_SECONDS). The
// API re-checks the window against the MEASURED source; these are the
// clip-independent bounds only.
export const H3_MAX_INSERT_ALIAS = 'video.hailuo_03_max_insert';
const H3_MAX_INSERT_MIN_START_SECONDS = 1.625;
const H3_MAX_INSERT_MAX_TIME_SECONDS = 60;
// H3 Max Recast — mirrored from backend/src/lib/models/h3MaxRecast.ts
// (H3_MAX_RECAST_PUBLIC_ALIAS / _MAX_REFERENCE_IMAGES / _MIN/_MAX_SOURCE_SECONDS)
// and the registry's `limits.resolutions`. No flag of its own: the clip rides
// --source-video and the cast --ref-image. The API measures the clip (its
// length is the price) and stays the validator of record; these are the
// input-shape rules a run would 400 on anyway.
export const H3_MAX_RECAST_ALIAS = 'video.hailuo_03_max_recast';
const H3_MAX_RECAST_MAX_REFERENCE_IMAGES = 4;
const H3_MAX_RECAST_RESOLUTIONS = ['768p', '1080p'] as const;

/** True for the Recast alias however it is spelled (the seam's own normalisation). */
export function isH3MaxRecastAlias(model?: string): boolean {
  const normalized = String(model || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return normalized.includes('h3_max_recast') || normalized.includes('hailuo_03_max_recast');
}

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
  /** Seedance 2.5 draft: a 480p preview the 1080p final is rendered from. */
  draft?: boolean;
  style?: string;
  damageLevel?: string;
  insertStart?: string;
  insertResume?: string;
  /** commander's `--no-color-match`: true unless negated. */
  colorMatch?: boolean;
  /** `--keep-clip-audio` / `--no-keep-clip-audio`; undefined when neither was passed. */
  keepClipAudio?: boolean;
}

export function addVideoRequestOptions(cmd: Command): Command {
  cmd
    .option('-m, --model <model>', 'Public model alias, e.g. video.veo_3_1 (default: the API default video model)')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio (16:9, 9:16, 1:1, …; see limits in `genfire models get`; default 16:9). Genjudo runs (video.seedance_2_5 with a --ref-video, any --task) default to auto: the clip\'s own frame — the API applies the same default to a one-clip run')
    .option('-d, --duration <seconds>', 'Duration in seconds (model-dependent; default 5 — on video.seedance_2_5 too, which never picks its own length). video.seedance_2_5 with exactly one --ref-video, --task reference (or no --task) and -a left off (or auto) defaults to the clip\'s own measured length instead (the API also follows the clip when -a is the clip\'s own ratio) — rounded up to a whole second, 4-30, whether or not the clip\'s sound is kept — the same default the API applies')
    .option('-r, --resolution <resolution>', `Output resolution, model-dependent (e.g. 480p, 720p, 1080p, 4k; ${H3_MAX_RECAST_RESOLUTIONS.join(' or ')} on ${H3_MAX_RECAST_ALIAS}). Higher resolutions cost more credits.`)
    .option('-i, --image <urlOrPath>', 'Start frame (image-to-video): URL, local path (auto-uploaded) or a completed run id — e.g. a video run\'s last_frame_url to continue that shot. On video.seedance_2_5 with any --ref-image / --ref-video / --ref-audio it is not animated: the API adds it to the reference images after your --ref-image list, as the next @ImageN')
    .option('--end-image <urlOrPath>', 'Last frame the clip lands on, paired with --image (or --start-image on Kling O3 / Kling 4.0). Supported where capabilities.end_frame is true (Seedance, Kling V3/O3/2.6/4.0, Hailuo 03/02 Standard)')
    .option('--start-image <urlOrPath>', 'Kling O3 / Kling 4.0 structured start frame (start_image_url) — use with --elements-file / --multi-prompt; other models take --image')
    .option('--first-frame <urlOrPath>', 'First frame of a first/last-frame clip (needs --last-frame; models with capabilities.first_last_frame)')
    .option('--last-frame <urlOrPath>', 'Last frame of a first/last-frame clip (needs --first-frame)')
    .option('--source-video <urlOrPath>', `Source clip to edit / extend / restyle / recast (video-to-video models — capabilities.source_video). Source-tracking edits bill the clip's measured length. On ${H3_MAX_RECAST_ALIAS} it is the clip whose people are recast (5-30s, no single shot over 15s; billed per second of it) — pass the photos with --ref-image and "" as the prompt if you have nothing to add`)
    .option('--ref-image <urlOrPath...>', `Reference image URL(s), local paths or run ids — cite in the prompt as Image 1, Image 2, … (Hailuo 03, Wan 3.0) or @Image1, @Image2, … (Seedance). Up to 9 on most models, 10 on Wan 3.0 / Omni Flash 1.1 / Kling 4.0, 30 on video.seedance_2_5. On ${H3_MAX_RECAST_ALIAS} these are the new cast: 1-${H3_MAX_RECAST_MAX_REFERENCE_IMAGES} photos, one per person, replacing the main people left to right`)
    .option('--ref-video <urlOrPath...>', 'Reference clip URL(s), local paths or run ids — cite as Video 1… (Hailuo 03, Wan 3.0) or @Video1… (Seedance). Up to 3 on Hailuo 03 and Seedance 2.0, 5 on Wan 3.0 (15s total), 5 on video.kling_v4 (cite as @Video1…; each 3-30s, 30s TOTAL together with element videos — a longer pool is trimmed to fit), 10 on video.seedance_2_5 (each 2-30s, 30s TOTAL across the pool). On video.seedance_2_5 this is also the clip --task edits, extends or transfers motion from: --task editing and extension take exactly ONE clip, and an edit needs at least 4s of it. A prompt typed after this list is picked out of it (or put the prompt first)')
    .option('--ref-video-trim <spec...>', 'Time window for a --ref-video clip, as N:START-END in seconds (0-based N), e.g. --ref-video-trim 1:3-8 uses seconds 3–8 of the second clip. Only the window is sent. Must fit the model\'s per-clip cap (3s Omni Flash 1.1, 15s Hailuo 03 / Wan 3.0, 30s Seedance 2.0; 2-30s on video.seedance_2_5, where every window shares the 30s pool)')
    .option('--ref-audio <urlOrPath...>', 'Reference audio URL(s), local paths or run ids — cite as Audio 1… (Hailuo 03, Wan 3.0) or @Audio1… (Seedance). Up to 3 on Hailuo 03 and Seedance 2.0 (2-15s each), 10 on video.seedance_2_5 (each 2-30s and ≤15 MB, 30s TOTAL across the pool), 5 on Wan 3.0 (15s total). Gives a character a consistent voice. Needs at least one --ref-image or --ref-video alongside it')
    .option('--keyframe <FRAME:urlOrPath>', 'Pin an image at a 24 fps frame index, e.g. --keyframe 0:start.png --keyframe 96:end.png (Flux 3 keyframes-to-video; capabilities.keyframes). Repeatable', collect, [] as string[])
    .option('--draft-cache-url <url>', 'Flux 3 draft-enhance: the draft_cache_url a previous /draft run returned')
    .option('--file-url <urlOrPath>', 'Document to ground the clip on (Wan 3.0 reference-to-video; turns thinking on)')
    .option('--web-url <url>', 'Web page to ground the clip on (Wan 3.0 reference-to-video; turns thinking on)')
    .option('--lora <id[:scale]>', 'Trained video model (subject LoRA) from `genfire trained-models list`, optional :scale. Repeat for up to 3 (Hailuo 03)', collect, [] as string[])
    .option('--elements-file <path>', `Kling O3 / Kling 4.0 elements: JSON array of { frontal_image_url | video_url, reference_image_urls?, voice_id? } — up to 3 on Kling O3 (one with a video); up to ${KLING4_MAX_ELEMENTS} on ${KLING4_ALIAS} (up to ${KLING4_MAX_VIDEO_ELEMENTS} with a video), where an image element is a front + 1-3 extra angles (a lone image is used as its own view)`)
    .option('--multi-prompt <[SECONDS:]prompt>', `Kling O3 / Kling 4.0 multi-shot: one shot per flag, optional leading duration (1-15 s on Kling O3, 1-${KLING4_MAX_SHOT_SECONDS} s on ${KLING4_ALIAS}, whose shots add up to the clip — pass "" as the prompt there), e.g. --multi-prompt "5:she opens the door" --multi-prompt "he waves"`, collect, [] as string[])
    .option('--shot-type <type>', 'Kling O3 multi-shot mode: customize | intelligent')
    .option('--camera-path <preset>', `H3 Max Multi Angle camera move: ${CAMERA_PATH_IDS.join(', ')}`)
    .option('--camera-trajectory <file>', 'H3 Max Multi Angle explicit camera path: JSON array of 2-12 { time, azimuth, elevation, distance } keyframes')
    .option('--no-audio', 'Disable audio generation if the model supports it')
    .option('--bitrate <mode>', 'Output encode quality: standard or high (high = larger, higher-quality file at no extra cost). Seedance 2.0 Standard/Fast only — it has no effect on video.seedance_2_5 (not sent) or any other model (ignored by the API)')
    .option('--bitrate-mode <mode>', 'Alias of --bitrate (kept for scripts written before --bitrate existed)')
    .option('--draft', 'video.seedance_2_5 only: render a 480p PREVIEW at the 480p price (-r is ignored). Happy with it? `genfire generate draft-final <run_id>` renders that same shot in native 1080p, within 7 days')
    .option('--task <task>', 'GENFIRE GENJUDO, video.seedance_2_5 only: reference (motion transfer — the --ref-video supplies the motion, --ref-image supplies who performs it; with ONE clip and -a / -d left off it MATCHES THE CLIP, its frame and its measured length), editing (video edit — re-light, swap, clean up the --ref-video itself; the output follows the source, so leave -a and -d off) or extension (continue the clip). editing and extension need exactly one --ref-video. A video.seedance_2_5 run with a --ref-video and no --task runs as reference. With ONE clip, reference and editing keep the clip\'s own sound (when it has a soundtrack and no --ref-audio is sent) unless you pass --no-keep-clip-audio or --no-audio. These are exactly the defaults the API applies to a one-clip run — never to two or more clips, never to extension — so leaving them to the CLI or the API renders the same clip. Recipes with the prompts written for you: genfire genjudo presets')
    .option('--keep-clip-audio', 'Genjudo (video.seedance_2_5 with a --ref-video): keep the CLIP\'S OWN SOUND. The clip goes in silent and its original audio is laid back on the result, instead of a generated soundtrack. The default for a ONE-clip --task reference (also when --task is omitted) or --task editing run whose clip has a soundtrack, when no --ref-audio is sent — as in the web Genjudo and the API. No effect on --task extension (the new seconds have no source audio)')
    .option('--no-keep-clip-audio', 'Genjudo: let the model make the soundtrack instead of keeping the clip\'s own — sends keep_source_audio false, so the API\'s keep-the-clip-sound default does not apply either (add --no-audio for a silent result)')
    .option('--style <style>', `H3 Max Styles look: ${H3_MAX_STYLE_IDS.join(', ')}. Runs on ${H3_MAX_STYLES_ALIAS} (picked for you when -m is omitted): 5-15s, fixed 768p with audio, one flat rate for every look. Optional --image first frame; no --end-image or references`)
    .option('--damage-level <level>', `With --style vhs only: tape wear, ${H3_MAX_DAMAGE_LEVELS.join(', ')} (default medium)`)
    .option('--insert-start <seconds>', `H3 Max Insert: second of --source-video where the NEW scene begins (≥${H3_MAX_INSERT_MIN_START_SECONDS}). Needs --insert-resume; runs on ${H3_MAX_INSERT_ALIAS} (picked for you when -m is omitted). The prompt and/or --ref-image (≤9) / --ref-video (≤3) describe the new scene; -d (5-13) is the new scene's length and the only seconds billed; the whole edited clip comes back`)
    .option('--insert-resume <seconds>', `H3 Max Insert: second where the original footage picks up again — after --insert-start, ≤${H3_MAX_INSERT_MAX_TIME_SECONDS} and before the clip ends (leave footage after it for the transition)`)
    .option('--no-color-match', 'H3 Max Insert: do not grade the new scene to the source (it is colour-matched by default)');
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

// ─── Kling 4.0 (video.kling_v4 / video.kling_v4_flash) ──────────────────────
// The API's seam limits, mirrored for the checks made before anything uploads.
const KLING4_ALIAS = 'video.kling_v4';
const KLING4_MAX_ELEMENTS = 7;
const KLING4_MAX_VIDEO_ELEMENTS = 3;
const KLING4_MAX_SHOT_SECONDS = 30;

/** Any Kling 4.0 alias (4.0 or Flash). */
export function isKling4Alias(model?: string): boolean {
  return /^video\.kling_v4(?:_flash)?$/.test(String(model ?? '').trim().toLowerCase());
}

/**
 * `[SECONDS:]prompt` → `{ prompt, duration? }` (Kling O3 wants the duration as
 * a string). Shots run 1-15 s on Kling O3 and 1-30 s on Kling 4.0 (`model`).
 */
export function parseMultiPrompt(specs: string[] | undefined, model?: string): Array<{ prompt: string; duration?: string }> | undefined {
  if (!specs || specs.length === 0) return undefined;
  const maxShotSeconds = isKling4Alias(model) ? KLING4_MAX_SHOT_SECONDS : 15;
  return specs.map((spec) => {
    const m = /^(\d{1,2})\s*:\s*([\s\S]+)$/.exec(spec);
    if (m) {
      const seconds = Number(m[1]);
      if (seconds < 1 || seconds > maxShotSeconds) {
        throw new CliError(`--multi-prompt "${spec}": shot duration must be 1-${maxShotSeconds} seconds.`, 'invalid_multi_prompt');
      }
      return { prompt: m[2].trim(), duration: String(seconds) };
    }
    if (!spec.trim()) throw new CliError('--multi-prompt needs a prompt.', 'invalid_multi_prompt');
    return { prompt: spec.trim() };
  });
}

/** `--insert-start` / `--insert-resume` → seconds, clip-independent bounds checked; undefined when neither was passed. */
export function parseInsertWindow(opts: Pick<VideoFlags, 'insertStart' | 'insertResume' | 'sourceVideo'>): { start: number; resume: number } | undefined {
  if (opts.insertStart === undefined && opts.insertResume === undefined) return undefined;
  if (opts.insertStart === undefined || opts.insertResume === undefined) {
    throw new CliError('--insert-start and --insert-resume are the two edit points of H3 Max Insert — pass both.', 'insert_window_required');
  }
  const start = num(opts.insertStart.replace(/s$/i, ''), '--insert-start', { min: H3_MAX_INSERT_MIN_START_SECONDS, max: H3_MAX_INSERT_MAX_TIME_SECONDS })!;
  const resume = num(opts.insertResume.replace(/s$/i, ''), '--insert-resume', { min: H3_MAX_INSERT_MIN_START_SECONDS, max: H3_MAX_INSERT_MAX_TIME_SECONDS })!;
  if (resume <= start) {
    throw new CliError(`--insert-resume (${resume}) must be later than --insert-start (${start}).`, 'invalid_insert_window');
  }
  if (!opts.sourceVideo) {
    throw new CliError('H3 Max Insert cuts a new scene into an existing clip — pass it with --source-video.', 'source_video_url_required');
  }
  return { start, resume };
}

/**
 * H3 Max Recast's input shape, refused locally before anything uploads: the
 * clip and at least one cast photo are both required (there is no text or
 * image mode to fall back on), the cast caps at 4, and it has no reference
 * clip / audio pool or start frame. A no-op for every other model.
 */
export function validateRecastFlags(opts: VideoFlags): void {
  if (!isH3MaxRecastAlias(opts.model)) return;
  if (!opts.sourceVideo) {
    throw new CliError('H3 Max Recast recasts the people in an existing clip — pass it with --source-video (5-30s).', 'source_video_url_required');
  }
  if (opts.image || opts.startImage || opts.endImage || opts.firstFrame || opts.lastFrame) {
    throw new CliError('H3 Max Recast takes the new people\'s photos as --ref-image, not as a start / end frame.', 'unsupported_input_combination');
  }
  const cast = opts.refImage?.length ?? 0;
  if (cast === 0) {
    throw new CliError('H3 Max Recast needs a photo of each new person — pass 1-4 with --ref-image (photo 1 replaces the leftmost main person).', 'reference_image_urls_required');
  }
  if (cast > H3_MAX_RECAST_MAX_REFERENCE_IMAGES) {
    throw new CliError(`H3 Max Recast takes up to ${H3_MAX_RECAST_MAX_REFERENCE_IMAGES} people (one --ref-image each) — remove ${cast - H3_MAX_RECAST_MAX_REFERENCE_IMAGES}.`, 'invalid_reference_image_urls');
  }
  if (opts.refVideo?.length || opts.refAudio?.length) {
    throw new CliError('H3 Max Recast takes cast photos only — no --ref-video or --ref-audio (the clip keeps its own sound).', 'unsupported_reference_media');
  }
  // Spelled as the API lists it (`limits.resolutions`, lower-case) — that is
  // what the body sends and what the API checks.
  const resolution = opts.resolution?.trim();
  if (resolution !== undefined && !(H3_MAX_RECAST_RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new CliError(`H3 Max Recast renders ${H3_MAX_RECAST_RESOLUTIONS.join(' or ')} (got "${opts.resolution}").`, 'invalid_resolution');
  }
}

/** Validation that needs no network — runs before anything is uploaded. */
export function validateVideoFlags(opts: VideoFlags): void {
  validateRecastFlags(opts);
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
      '--end-image is the LAST frame of an image-to-video clip. Pair it with --image (or --start-image on Kling O3 / Kling 4.0).',
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
  // --bitrate on video.seedance_2_5 (no encode setting) is simply not sent —
  // see buildVideoRequest — and the API ignores it on every other model
  // without the capability; neither value is refused (owner decision
  // 2026-10-12). --image beside reference media on 2.5 is not refused either:
  // the API folds the image into the reference images as the next @ImageN.
  const task = oneOf(opts.task, VIDEO_TASKS, '--task');
  if ((task === 'editing' || task === 'extension') && !opts.refVideo?.length) {
    throw new CliError(
      `--task ${task} works on an existing clip. Pass it with --ref-video (and cite it as @Video1 in the prompt).`,
      'task_requires_reference_video'
    );
  }
  // The API refuses more than one (task_requires_one_reference_video) — after
  // every clip was uploaded. Same rule, before anything is.
  if ((task === 'editing' || task === 'extension') && (opts.refVideo?.length ?? 0) > 1) {
    throw new CliError(
      `--task ${task} works on ONE clip at a time — pass a single --ref-video (got ${opts.refVideo!.length}).`,
      'task_requires_one_reference_video'
    );
  }
  if (opts.keepClipAudio === true) {
    if (!isGenjudoModel(opts.model)) {
      throw new CliError(`--keep-clip-audio is a Genjudo option — run it on -m ${GENJUDO_MODEL}.`, 'unsupported_genjudo_option');
    }
    if (!opts.refVideo?.length) {
      throw new CliError('--keep-clip-audio keeps a clip\'s own sound — pass the clip with --ref-video.', 'keep_clip_audio_requires_reference_video');
    }
    // On --task extension it has no effect (the new seconds have no source
    // sound): not refused, and not sent (genjudoFields) — the API ignores it too.
  }
  oneOf(opts.shotType, ['customize', 'intelligent'], '--shot-type');
  oneOf(opts.cameraPath, CAMERA_PATH_IDS, '--camera-path');
  if (opts.cameraPath && opts.cameraTrajectory) {
    throw new CliError('Pass --camera-path OR --camera-trajectory, not both.', 'invalid_camera_trajectory');
  }
  num(opts.duration, '--duration', { int: true, min: 1, max: 30 });
  const insertWindow = parseInsertWindow(opts);
  if (opts.colorMatch === false && !insertWindow) {
    throw new CliError('--no-color-match is an H3 Max Insert setting — pass it with --insert-start / --insert-resume.', 'unsupported_color_match');
  }
  parseRefVideoTrims(opts.refVideoTrim, opts.refVideo?.length ?? 0);
  parseMultiPrompt(opts.multiPrompt, opts.model);
  parseLoraSpecs(opts.lora, '--lora', 3);
  for (const spec of opts.keyframe ?? []) {
    if (!/^\d+:.+$/.test(spec)) {
      throw new CliError(`--keyframe "${spec}" must look like FRAME:urlOrPath (e.g. 0:start.png).`, 'invalid_keyframes');
    }
  }
}

// ─── Genfire Genjudo defaults (video.seedance_2_5 + --task) ──────────────────

const GENJUDO_MODEL = 'video.seedance_2_5';
// Shortest / longest single Seedance 2.5 pass — the web Genjudo's
// GEDI_MIN/MAX_DURATION_SECONDS (frontend buildGediRequest).
const GENJUDO_MIN_SECONDS = 4;
const GENJUDO_MAX_SECONDS = 30;

function isGenjudoModel(model?: string): boolean {
  return String(model ?? '').trim().toLowerCase() === GENJUDO_MODEL;
}

/**
 * The task a Seedance 2.5 run with a clip actually RUNS: `--task`, or —
 * omitted — `reference`, the default the API leaves to the model (it sends
 * no task and the model applies "reference"). So every Genjudo default below
 * treats "no --task" exactly like `--task reference`. Undefined off Genjudo.
 */
function genjudoTask(opts: VideoFlags): string | undefined {
  if (!isGenjudoModel(opts.model) || !opts.refVideo?.length) return undefined;
  return opts.task?.trim().toLowerCase() || 'reference';
}

/**
 * The task of a ONE-clip Genjudo run the API applies its defaults to —
 * video.seedance_2_5, EXACTLY one --ref-video, `reference` (or no --task) or
 * `editing`. Undefined otherwise: two or more clips and extension get the
 * plain API defaults (16:9, 5 s, a generated soundtrack), and so get nothing
 * filled in here either.
 */
function genjudoDefaultTask(opts: VideoFlags): 'reference' | 'editing' | undefined {
  const task = genjudoTask(opts);
  if ((opts.refVideo?.length ?? 0) !== 1) return undefined;
  return task === 'reference' || task === 'editing' ? task : undefined;
}

/**
 * "Match the clip" length — the web's gediAutoDurationSeconds and the API's:
 * the clip's seconds rounded UP, clamped to what one pass renders (4-30),
 * whether or not its own sound is laid back on. A run that follows the clip
 * renders a whole-second length the provider picks (live 2026-10-12: a 4.5 s
 * window rendered 5.06 s), so rounding up bills what renders. Trade-off: a
 * kept soundtrack can end up to a second before the last frame.
 */
export function matchClipSeconds(clipSeconds: number): number {
  // Capped and rounded to the millisecond FIRST, exactly like the backend
  // (referenceVideoTrim seedance25FollowSourceBillableSeconds): a 1.1–16.1
  // window is 15.000…2 in floats, and ceiling that would send 16 for a 15 s clip.
  const clip = Math.round(Math.min(clipSeconds, GENJUDO_MAX_SECONDS) * 1000) / 1000;
  return Math.min(GENJUDO_MAX_SECONDS, Math.max(GENJUDO_MIN_SECONDS, Math.ceil(clip)));
}

/**
 * The Genjudo fields the web sends and the API ALSO defaults on its own —
 * filled in here under exactly the API's conditions, so the CLI renders the
 * same clip against a server that applies them and one that does not yet, and
 * the cost and generate bodies stay identical (both are built here):
 *   - ONE clip, reference (or no --task) or editing (genjudoDefaultTask):
 *     the frame follows the clip (`aspect_ratio: auto`) unless -a was passed;
 *   - ONE clip, reference, no -d, -a left off or auto: "Match the clip" — its
 *     measured length (the trimmed window when trimmed) plus `follow_source`;
 *   - ONE clip, reference / editing, no --keep-clip-audio / --no-keep-clip-
 *     audio / --no-audio, no --ref-audio, and a clip with a soundtrack: its
 *     own sound (`keep_source_audio`, the generated track off).
 * Two or more clips and extension get none of these, as from the API. The
 * clip is probed (the free POST /media/inspect) only when a default depends
 * on it. An unmeasurable clip fails a length match; when only the sound
 * depended on the probe, the sound fields are left to the API, which applies
 * the same rule to its own measurement. Explicit flags are sent as given —
 * `--no-keep-clip-audio` as `keep_source_audio: false`, or the API's default
 * would put the clip's sound back on (never on extension, where it has no effect).
 */
async function genjudoFields(
  opts: VideoFlags,
  referenceVideoUrls: string[] | undefined,
  trims: Array<{ index: number; start: number; end: number }>,
  inspectMedia: MediaInspector | undefined
): Promise<Record<string, unknown>> {
  const task = genjudoTask(opts);
  if (!task || !referenceVideoUrls?.length) return {};
  const fields: Record<string, unknown> = {};
  if (task !== 'extension' && opts.keepClipAudio === false) fields.keep_source_audio = false;
  // Never on extension, where it has no effect: sending it there would also
  // turn the generated soundtrack off and leave the new seconds silent.
  if (task !== 'extension' && opts.keepClipAudio === true) {
    fields.keep_source_audio = true;
    fields.generate_audio = false;
  }
  const defaultTask = genjudoDefaultTask(opts);
  if (!defaultTask) return fields;

  if (opts.aspectRatio === undefined) fields.aspect_ratio = 'auto';
  const followsClip = opts.aspectRatio === undefined || opts.aspectRatio.trim().toLowerCase() === 'auto';
  const matchLength = defaultTask === 'reference' && opts.duration === undefined && followsClip;
  const soundByDefault = opts.keepClipAudio === undefined && opts.audio !== false && !opts.refAudio?.length;
  if (!matchLength && !soundByDefault) return fields;

  let reason = '';
  const probe = inspectMedia
    ? await inspectMedia(referenceVideoUrls[0]).catch((err: unknown) => {
        reason = ` (${err instanceof Error ? err.message : String(err)})`;
        return null;
      })
    : null;
  if (soundByDefault && probe && probe.hasAudio !== false) {
    fields.keep_source_audio = true;
    fields.generate_audio = false;
  }
  if (matchLength) {
    const full = Number(probe?.durationSeconds);
    if (!Number.isFinite(full) || full <= 0) {
      throw new CliError(
        `Could not measure the --ref-video to match its length${reason}. Pass -d <seconds> (4-30) to set the length yourself.`,
        'reference_video_unmeasured'
      );
    }
    const trim = trims.find((t) => t.index === 0);
    const seconds = trim ? Math.max(0, Math.min(trim.end, full) - Math.min(trim.start, full)) : full;
    fields.duration = matchClipSeconds(seconds);
    fields.follow_source = true;
  }
  return fields;
}

async function resolveAll(entries: string[] | undefined, resolveMedia: MediaResolver): Promise<string[] | undefined> {
  if (!entries || entries.length === 0) return undefined;
  return Promise.all(entries.map((entry) => resolveMedia(entry)));
}

/**
 * The `/v1/videos/generations` body (minus `prompt` and the run-scoping
 * fields). `genfire cost video` posts the same object to
 * /v1/models/estimate-cost, so the routing (t2v / i2v / ref / edit / Genjudo
 * video-ref) and the quote fingerprint match the real submit.
 */
export async function buildVideoRequest(
  opts: VideoFlags,
  resolveMedia: MediaResolver,
  context: { inspectMedia?: MediaInspector } = {}
): Promise<Record<string, unknown>> {
  validateVideoFlags(opts);
  const style = opts.style !== undefined ? normalizeVideoStyle(opts.style) : undefined;
  const insertWindow = parseInsertWindow(opts);

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
    // Kling 4.0 takes up to 7 (the API refuses a 4th element video, or any on
    // Flash); Kling O3 — and an unnamed model — 3.
    const maxElements = isKling4Alias(opts.model) ? KLING4_MAX_ELEMENTS : 3;
    if (!Array.isArray(elements) || elements.length === 0 || elements.length > maxElements) {
      throw new CliError(
        isKling4Alias(opts.model)
          ? `--elements-file must hold a JSON array of 1-${KLING4_MAX_ELEMENTS} Kling 4.0 element objects.`
          : '--elements-file must hold a JSON array of 1-3 Kling O3 element objects (up to 7 on video.kling_v4).',
        'invalid_elements'
      );
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
  const genjudo = await genjudoFields(opts, referenceVideoUrls, trims, context.inspectMedia);
  return compact({
    // A style, and an insert window, each have one engine; everything else
    // keeps the API default.
    model: opts.model ?? (style ? H3_MAX_STYLES_ALIAS : insertWindow ? H3_MAX_INSERT_ALIAS : undefined),
    aspect_ratio: opts.aspectRatio ?? genjudo.aspect_ratio,
    duration: num(opts.duration, '--duration', { int: true }) ?? genjudo.duration,
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
    multi_prompt: parseMultiPrompt(opts.multiPrompt, opts.model),
    shot_type: opts.shotType?.trim().toLowerCase(),
    camera_path: opts.cameraPath?.trim().toLowerCase(),
    camera_trajectory: cameraTrajectory,
    // Only an explicit opt-out is sent. The API defaults to audio on, and the
    // quote fingerprint keys generate_audio only when it is a boolean — so
    // sending `true` by default made every default quote unspendable. Kling
    // 4.0 has no audio toggle at all (the API ignores it), so --no-audio is
    // not sent there.
    generate_audio: isKling4Alias(opts.model) ? undefined : opts.audio === false ? false : genjudo.generate_audio,
    // video.seedance_2_5 has no encode setting: --bitrate has no effect there,
    // so it is not sent (the same body for `cost video` and `generate video`).
    bitrate_mode: isGenjudoModel(opts.model) ? undefined : (opts.bitrate ?? opts.bitrateMode),
    task: opts.task?.trim().toLowerCase(),
    // Genjudo: the clip's own sound back on the result, and "Match the clip".
    // Sent only when they apply — the API 400s both on any other model.
    keep_source_audio: genjudo.keep_source_audio,
    follow_source: genjudo.follow_source,
    // Only when set: the API keys `draft` into the quote fingerprint only
    // when sent, so an absent flag keeps every non-draft quote spendable.
    draft: opts.draft ? true : undefined,
    video_style: style,
    damage_level: opts.damageLevel?.trim().toLowerCase(),
    insert_start_time: insertWindow?.start,
    insert_resume_time: insertWindow?.resume,
    // Only the explicit opt-out is sent: the API defaults to true, and any
    // other model 400s a color_match it was sent.
    color_match: opts.colorMatch === false ? false : undefined,
    ...(await buildGrounding(opts, resolveMedia))
  });
}

/**
 * `genfire cost video -n` → the `count` the estimate is sent, or undefined
 * when -n was not passed. Sent as given on every model: video.seedance_2_5
 * renders ONE video per request and the API clamps a count above 1 to 1
 * (quoting one video) rather than refusing it (owner decision 2026-10-12).
 */
export function videoEstimateCount(_model: string | undefined, count: string | undefined): number | undefined {
  return num(count, '--count', { int: true });
}

// ─── Seedance 2.5 draft → 1080p final ────────────────────────────────────────

/**
 * The /v1 path of a draft's 1080p final (or its estimate). Takes the draft's
 * run id (`run_…`, or a `dash_video_…` id from `genfire runs list`) or its
 * output video_id — whatever `generate video --draft` printed.
 */
export function draftFinalPath(draftId: string, estimate = false): string {
  const id = String(draftId ?? '').trim();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new CliError('Pass the draft\'s run id (run_…) from `genfire generate video --draft`, or its output video_id.', 'invalid_draft_id');
  }
  return `/videos/generations/${encodeURIComponent(id)}/final${estimate ? '/estimate' : ''}`;
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
