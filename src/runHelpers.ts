import { GenFireApiError, GenFireClient, Run, Upload } from '@genfire/sdk';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { publicApiRequest } from './client.js';
import { CliError } from './errors.js';
import { dim, green, yellow, printResult } from './output.js';
import { findExtensionSibling, uploadLocalFile, type UploadLocalFileOptions } from './upload.js';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 15 * 60 * 1000;
/**
 * `GET /v1/runs/:id?wait=N` holds the request until the run is terminal or N
 * seconds pass (backend runLongPoll: N clamped to 30, non-numeric → 400
 * `invalid_wait`). 25 stays under that ceiling and under common proxy idle
 * timeouts, so a 4.5-minute render is ~11 requests instead of ~135.
 */
export const LONG_POLL_WAIT_SECONDS = 25;

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onTick?: (run: Run, elapsedMs: number) => void;
  /** false = plain polling every `intervalMs` (no `?wait=`). Default true. */
  longPoll?: boolean;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

type RawGet = <T>(method: 'GET', path: string, options: { query?: Record<string, number>; signal?: AbortSignal }) => Promise<T>;

/**
 * The SDK client's own request method — same auth, base URL and
 * GenFireApiError as `getRun`, which on the pinned 0.23.0 takes no `wait`.
 * TypeScript-private only; null if a future SDK drops it, and the wait then
 * falls back to plain polling.
 */
function sdkRawGet(client: GenFireClient): RawGet | null {
  const fn = (client as unknown as { request?: unknown }).request;
  return typeof fn === 'function' ? (fn as RawGet).bind(client) : null;
}

export async function waitForRun(client: GenFireClient, runId: string, options: WaitOptions = {}): Promise<Run> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? POLL_MAX_MS;
  const startedAt = Date.now();
  const rawGet = options.longPoll === false ? null : sdkRawGet(client);
  let longPoll = rawGet !== null;
  const path = `/runs/${encodeURIComponent(runId)}`;

  const read = async (): Promise<Run> => {
    if (longPoll && rawGet) {
      // Never hold past the caller's own deadline.
      const wait = Math.min(LONG_POLL_WAIT_SECONDS, Math.floor((timeoutMs - (Date.now() - startedAt)) / 1000));
      if (wait >= 1) {
        try {
          return await rawGet<Run>('GET', path, { query: { wait }, signal: options.signal });
        } catch (err) {
          // An API that rejects `wait` gets plain polling from here on.
          if (!(err instanceof GenFireApiError && err.status === 400 && err.code === 'invalid_wait')) throw err;
          longPoll = false;
        }
      }
    }
    return client.getRun(runId, options.signal);
  };

  // First read is immediate: a finished run returns at once, and the first
  // tick shows the real status instead of waiting out a long-poll.
  let run = await client.getRun(runId, options.signal);
  if (TERMINAL_STATUSES.has(run.status)) {
    options.onTick?.(run, 0);
    return run;
  }

  while (Date.now() - startedAt < timeoutMs) {
    options.onTick?.(run, Date.now() - startedAt);
    const requestedAt = Date.now();
    // While a long-poll is held open, keep the elapsed counter moving.
    const ticker = longPoll && options.onTick
      ? setInterval(() => options.onTick!(run, Date.now() - startedAt), intervalMs)
      : null;
    try {
      if (!longPoll) await sleep(intervalMs, options.signal);
      run = await read();
    } finally {
      if (ticker) clearInterval(ticker);
    }
    if (TERMINAL_STATUSES.has(run.status)) {
      options.onTick?.(run, Date.now() - startedAt);
      return run;
    }
    // A long-poll answered early and unfinished (an API that ignores `wait`)
    // must not turn into a tight request loop.
    const spent = Date.now() - requestedAt;
    if (longPoll && spent < intervalMs) await sleep(intervalMs - spent, options.signal);
  }

  throw new CliError(
    `Run ${runId} did not complete within ${Math.round(timeoutMs / 1000)}s. The run may still finish later — check with \`genfire runs get ${runId}\`.`,
    'wait_timeout'
  );
}

/** One node's state inside a canvas run. */
export interface CanvasRunNode {
  nodeId: string;
  status: string;
  error?: string;
  output: { type: string; url?: string; text?: string } | null;
}

export interface CanvasRunDeliverable {
  node_id: string;
  kind: string;
  output: { type: string; url?: string; text?: string };
}

/** What `GET /v1/user-workflows/{workflowId}/runs/{runId}` answers. */
export interface CanvasWorkflowRunStatus {
  runId: string;
  workflowId: string;
  pageId: string;
  status: string;
  totalCostCredits: number;
  workflowRev: number | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  nodes: CanvasRunNode[];
  output: { deliverables: CanvasRunDeliverable[]; intermediates: CanvasRunDeliverable[] };
}

// A canvas run is 'cancelled'-terminal as well as completed/failed — the
// executor writes all three (backend RunStatus), and waiting past a cancel
// would burn the whole timeout for a run that is never coming back.
const CANVAS_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface CanvasWaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onTick?: (run: CanvasWorkflowRunStatus, elapsedMs: number) => void;
  /**
   * Transport seam, defaulted to the live `publicApiRequest`. Only the tests
   * pass it — they stand in a fake so the polled PATH can be asserted, which
   * is the entire bug this helper exists for.
   */
  request?: typeof publicApiRequest;
}

/** The only route a canvas run is readable on. */
export function canvasRunPath(workflowId: string, runId: string): string {
  return `/user-workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`;
}

/**
 * `waitForRun` for a CANVAS run — a `workflow run-canvas`, or a `preset run`,
 * whose 202 is a canvas kickoff under the caller's own instantiated copy.
 *
 * Separate from `waitForRun` because the run document lives under
 * `workflows/{workflowId}/runs/{runId}` and is readable ONLY at
 * `GET /v1/user-workflows/{workflowId}/runs/{runId}`. `GET /v1/runs/{id}`
 * looks in the flat run collection and answers 404 `run_not_found` — which,
 * on the first poll of a run the server has ALREADY billed, surfaced as a
 * failed command for a generation that was in fact running.
 *
 * Same backoff and timeout as `waitForRun`; only the route and the terminal
 * set differ.
 */
export async function waitForCanvasRun(
  workflowId: string,
  runId: string,
  options: CanvasWaitOptions = {}
): Promise<CanvasWorkflowRunStatus> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? POLL_MAX_MS;
  const request = options.request ?? publicApiRequest;
  const startedAt = Date.now();
  const read = () => request<CanvasWorkflowRunStatus>('GET', canvasRunPath(workflowId, runId));

  let run = await read();
  if (CANVAS_TERMINAL_STATUSES.has(run.status)) {
    options.onTick?.(run, 0);
    return run;
  }

  while (Date.now() - startedAt < timeoutMs) {
    options.onTick?.(run, Date.now() - startedAt);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      }, { once: true });
    });
    run = await read();
    if (CANVAS_TERMINAL_STATUSES.has(run.status)) {
      options.onTick?.(run, Date.now() - startedAt);
      return run;
    }
  }

  throw new CliError(
    `Run ${runId} did not complete within ${Math.round(timeoutMs / 1000)}s. The run may still finish later — check with \`genfire workflow run-status ${workflowId} ${runId}\`.`,
    'wait_timeout'
  );
}

export type ResolveMediaOptions = UploadLocalFileOptions;

/**
 * Auto-resolves a media flag value: an http(s) URL is returned as-is; a local
 * file is uploaded (typed by extension, see upload.ts) and its asset_url
 * returned; a completed run's id resolves to that run's output URL.
 */
export async function resolveMediaInput(
  client: GenFireClient,
  value: string,
  options: ResolveMediaOptions = {}
): Promise<{ url: string; uploaded?: Upload }> {
  if (/^https?:\/\//i.test(value)) {
    return { url: value };
  }

  try {
    const stats = await stat(value);
    if (!stats.isFile()) {
      throw new CliError(`Path is not a file: ${value}`, 'invalid_media_input');
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { url: await resolveMissingPath(client, value) };
    }
    throw err;
  }

  const upload = await uploadLocalFile(client, value, options);
  return { url: upload.asset_url, uploaded: upload };
}

/**
 * A value that is not a file on disk: a run id, a file whose extension was
 * left off, or a mistake — told apart in that order of evidence.
 *
 * A completed run's id stands in for its output — the same run-id media
 * reference the MCP tools accept, so `-i run_abc` chains one generation into
 * the next without a download/re-upload. It is checked only after the path
 * lookup misses, so a local file that happens to be named run_x still wins.
 *
 * `IMG_1234` (Finder hides the `.MOV`) is id-SHAPED, and used to go straight to
 * GET /runs/IMG_1234 and come back as an API run_not_found the user could not
 * connect to the file they meant. An ISSUED run id (`run_…`, `dash_…`) is
 * still looked up first; anything else names a sibling with an extension
 * before any lookup, and a lookup that misses says the value is neither.
 */
async function resolveMissingPath(client: GenFireClient, value: string): Promise<string> {
  // An id the API issues is a run first: `run_x` must not turn into "did you
  // mean run_x.mp4?" when it is a real run. The sibling only phrases the 404.
  if (ISSUED_RUN_ID.test(value)) {
    try {
      return await resolveRunOutputUrl(client, value);
    } catch (err) {
      if (err instanceof GenFireApiError && err.status === 404) {
        const sibling = findExtensionSibling(value);
        throw new CliError(
          `${value} is neither a local file nor a run on your account${sibling ? ` — did you mean ${sibling}?` : '.'}`,
          'media_not_found'
        );
      }
      throw err;
    }
  }
  const sibling = findExtensionSibling(value);
  if (sibling) {
    throw new CliError(`File not found: ${value} — did you mean ${sibling}?`, 'file_not_found');
  }
  if (RUN_ID_REF.test(value)) {
    try {
      return await resolveRunOutputUrl(client, value);
    } catch (err) {
      // Not a prefix the API issues, so any refusal means "not a run".
      if (err instanceof GenFireApiError && err.status >= 400 && err.status < 500) {
        throw new CliError(`${value} is neither a local file nor a run on your account.`, 'media_not_found');
      }
      throw err;
    }
  }
  const hint = /\s/.test(value) ? ' If this is your prompt, put it before the options (or after `--`).' : '';
  throw new CliError(
    `Media input is neither an http(s) URL nor an existing local file: ${value}.${hint}`,
    'invalid_media_input'
  );
}

// Id-SHAPED: one word, an underscore, no dot or slash. What GET /runs/:id is
// tried for once the value is not a file on disk.
export const RUN_ID_REF = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]+$/;
// The prefixes the API actually issues (PublicApiRunService): `run_<hex>` for
// API runs, `dash_<kind>_<docId>` for dashboard-projected ones.
export const ISSUED_RUN_ID = /^(?:run_[A-Za-z0-9]+|dash_(?:image|video|audio|reel|model3d|game|app)_[A-Za-z0-9_-]+)$/;

/** The FREE `POST /v1/media/inspect` probe (duration, frame, audio) of a URL. */
export function inspectMediaUrl(url: string): Promise<{ durationSeconds?: number | null; hasAudio?: boolean | null }> {
  return publicApiRequest<{ durationSeconds?: number | null; hasAudio?: boolean | null }>('POST', '/media/inspect', { body: { url } });
}

/** The primary output URL of a completed run, for `run_…` media references. */
export async function resolveRunOutputUrl(client: GenFireClient, runId: string): Promise<string> {
  const run = await client.getRun(runId);
  if (run.status !== 'completed') {
    throw new CliError(
      `Run ${runId} is ${run.status}; only a completed run can be used as a media input.`,
      'run_not_completed'
    );
  }
  const [first] = extractOutputUrls(run, runId);
  if (!first) {
    throw new CliError(`Run ${runId} has no media output to use as an input.`, 'run_has_no_media');
  }
  return first.url;
}

interface OutputFile {
  url: string;
  suggestedName: string;
}

/**
 * Pulls the user-facing output URLs out of a Run's `output` blob. The shape
 * varies per capability (videos: { video: { url } }, images: { images: [{ url }] },
 * audio: { audio_url }, etc.) so we walk it generically.
 */
export function extractOutputUrls(run: Run, fallbackBase = 'output'): OutputFile[] {
  if (!run.output || typeof run.output !== 'object') return [];
  const collected: OutputFile[] = [];
  let imageCounter = 0;

  function walk(value: unknown, depth = 0): void {
    if (depth > 6) return;
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      const ext = extensionFromUrl(value) || '.bin';
      collected.push({ url: value, suggestedName: `${fallbackBase}${++imageCounter > 1 ? `-${imageCounter}` : ''}${ext}` });
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      // Prefer canonical url-bearing keys before recursing.
      const obj = value as Record<string, unknown>;
      const directKeys = ['url', 'video_url', 'audio_url', 'asset_url', 'output_url', 'download_url'];
      for (const key of directKeys) {
        if (typeof obj[key] === 'string' && /^https?:\/\//i.test(obj[key] as string)) {
          const url = obj[key] as string;
          const ext = extensionFromUrl(url) || '.bin';
          collected.push({ url, suggestedName: `${fallbackBase}${++imageCounter > 1 ? `-${imageCounter}` : ''}${ext}` });
          return;
        }
      }
      for (const entry of Object.values(obj)) walk(entry, depth + 1);
    }
  }

  walk(run.output);
  return collected;
}

function extensionFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const ext = extname(path).toLowerCase();
    return ext.length > 1 && ext.length <= 6 ? ext : null;
  } catch {
    return null;
  }
}

export async function downloadOutputs(
  outputs: OutputFile[],
  destination: string | undefined,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<string[]> {
  if (outputs.length === 0) return [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const writtenPaths: string[] = [];

  if (destination && outputs.length === 1) {
    // Single output to an explicit path.
    const path = await ensureDestinationDir(destination);
    await downloadOne(fetchImpl, outputs[0].url, path);
    writtenPaths.push(path);
    return writtenPaths;
  }

  // Either no -o (use cwd + suggested names) or multiple outputs.
  const dir = destination ? destination : process.cwd();
  if (destination) await mkdir(dir, { recursive: true });

  for (const output of outputs) {
    const target = destination
      ? join(dir, basename(output.suggestedName))
      : join(dir, basename(output.suggestedName));
    await downloadOne(fetchImpl, output.url, target);
    writtenPaths.push(target);
  }
  return writtenPaths;
}

async function ensureDestinationDir(path: string): Promise<string> {
  const parent = dirname(path);
  if (parent && parent !== '.') {
    await mkdir(parent, { recursive: true });
  }
  return path;
}

async function downloadOne(fetchImpl: typeof fetch, url: string, destPath: string): Promise<void> {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    throw new CliError(`Download failed (${response.status}) for ${url}`, 'download_failed');
  }
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(destPath));
}

/**
 * A completed video run's `output.last_frame_url` — a still of the final frame
 * at the video's resolution, for chaining the next shot — or null.
 */
export function lastFrameUrlOf(run: Pick<Run, 'output'> | null | undefined): string | null {
  const url = run?.output?.last_frame_url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Where `--save-last-frame` writes the still: beside the video when exactly
 * one file was saved (`shot.mp4` → `shot.last-frame.jpg`), else
 * `<base>-last-frame.<ext>` in the -o directory (or the cwd).
 */
export function lastFrameTargetPath(
  url: string,
  savedVideoPaths: string[],
  destination: string | undefined,
  fallbackBase = 'video'
): string {
  const ext = extensionFromUrl(url) || '.jpg';
  if (savedVideoPaths.length === 1) {
    const video = savedVideoPaths[0];
    const stem = basename(video, extname(video));
    return join(dirname(video), `${stem}.last-frame${ext}`);
  }
  return join(destination || process.cwd(), `${fallbackBase}-last-frame${ext}`);
}

export function reportRunCompletion(run: Run, downloadedPaths: string[], opts: { lastFrameSaved?: boolean } = {}): void {
  printResult({ run, downloaded_to: downloadedPaths }, () => {
    if (run.status === 'completed') {
      process.stderr.write(`${green('Run completed.')} ${dim(`(${run.id})`)}\n`);
      if (downloadedPaths.length > 0) {
        for (const path of downloadedPaths) {
          process.stderr.write(`${dim('Saved:')} ${path}\n`);
        }
      } else {
        process.stderr.write(`${yellow('No output URLs were extracted from the run.')}\n`);
      }
      // The still of the final frame, when the video has one and it was not
      // saved above: the URL to pass as --image on the next shot.
      const lastFrame = lastFrameUrlOf(run);
      if (lastFrame && !opts.lastFrameSaved) {
        process.stderr.write(`${dim('Last frame:')} ${lastFrame}\n`);
      }
    } else if (run.status === 'failed') {
      // Carries the run id, so it prints as "Run <id> failed: …" + the `runs get` hint.
      throw new CliError(run.error?.message || 'no error detail was recorded', run.error?.code || 'run_failed', 1, run.id);
    } else {
      process.stderr.write(`${dim(`Run is ${run.status}. Use \`genfire runs get ${run.id}\` to check later.`)}\n`);
    }
  });
}

export function isApiError(err: unknown): err is GenFireApiError {
  return err instanceof GenFireApiError;
}
