import { GenFireApiError, GenFireClient, Run, Upload } from '@genfire/sdk';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CliError } from './errors.js';
import { dim, green, yellow, printResult } from './output.js';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 15 * 60 * 1000;

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onTick?: (run: Run, elapsedMs: number) => void;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

export async function waitForRun(client: GenFireClient, runId: string, options: WaitOptions = {}): Promise<Run> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? POLL_MAX_MS;
  const startedAt = Date.now();

  // First fetch
  let run = await client.getRun(runId, options.signal);
  if (TERMINAL_STATUSES.has(run.status)) {
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
    run = await client.getRun(runId, options.signal);
    if (TERMINAL_STATUSES.has(run.status)) {
      options.onTick?.(run, Date.now() - startedAt);
      return run;
    }
  }

  throw new CliError(
    `Run ${runId} did not complete within ${Math.round(timeoutMs / 1000)}s. The run may still finish later — check with \`genfire runs get ${runId}\`.`,
    'wait_timeout'
  );
}

/**
 * Auto-resolves a media flag value: if it's an http(s) URL, return as-is;
 * if it looks like a local path that exists, upload it and return the asset_url.
 */
export async function resolveMediaInput(client: GenFireClient, value: string): Promise<{ url: string; uploaded?: Upload }> {
  if (/^https?:\/\//i.test(value)) {
    return { url: value };
  }

  try {
    const stats = await stat(value);
    if (!stats.isFile()) {
      throw new CliError(`Path is not a file: ${value}`, 'invalid_media_input');
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new CliError(
        `Media input is neither an http(s) URL nor an existing local file: ${value}`,
        'invalid_media_input'
      );
    }
    throw err;
  }

  const upload = await client.uploadFile(value);
  return { url: upload.asset_url, uploaded: upload };
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

export function reportRunCompletion(run: Run, downloadedPaths: string[]): void {
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
    } else if (run.status === 'failed') {
      const detail = run.error?.message ? `: ${run.error.message}` : '';
      throw new CliError(`Run failed${detail}`, run.error?.code || 'run_failed');
    } else {
      process.stderr.write(`${dim(`Run is ${run.status}. Use \`genfire runs get ${run.id}\` to check later.`)}\n`);
    }
  });
}

export function isApiError(err: unknown): err is GenFireApiError {
  return err instanceof GenFireApiError;
}
