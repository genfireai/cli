import type { GenFireClient, Upload } from '@genfire/sdk';
import * as fs from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { CliError } from './errors.js';

/**
 * Local-file uploads: `POST /v1/uploads` for a signed URL, then one PUT of the
 * bytes to storage.
 *
 * Not the SDK's `uploadFile`: the pinned @genfire/sdk 0.23.0 sends no content
 * type (the API then stores every file as application/octet-stream, which a
 * video model can refuse as "not a video"), reads the whole file into memory,
 * never retries, and fails as `Upload PUT failed with status 403.` with no file
 * name or reason. The `createUpload` call still goes through the SDK, so auth
 * and API errors are exactly the SDK's. The SDK source carries the same content
 * type + error fixes for its next cut.
 */

/** The API's `MAX_UPLOAD_SIZE_BYTES` (publicV1.ts): one signed PUT, 5 GiB. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Extension → MIME type, the ONE table every CLI upload reads. Lower-case keys;
 * lookups lower-case the extension, so `IMG_1234.MOV` is a video/quicktime.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  // images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  // video
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  // documents / data
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  pdf: 'application/pdf',
  zip: 'application/zip',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json'
};

/** The MIME type for a path's extension (any case), or undefined when unknown. */
export function contentTypeForPath(path: string): string | undefined {
  const ext = extname(path).slice(1).toLowerCase();
  return ext && Object.hasOwn(MIME_BY_EXTENSION, ext) ? MIME_BY_EXTENSION[ext] : undefined;
}

/** True when the value ends in an image / video / audio extension the table knows. */
export function hasMediaExtension(value: string): boolean {
  const type = contentTypeForPath(value);
  return Boolean(type && /^(image|video|audio)\//.test(type));
}

/**
 * `IMG_1234` → `IMG_1234.MOV` when that file sits next to it (any case), so a
 * hidden extension is named instead of the value being misread. Media
 * extensions win over others; null when there is no such sibling.
 */
export function findExtensionSibling(value: string): string | null {
  const base = basename(value);
  if (!base || base.startsWith('.') || extname(base)) return null;
  const dir = dirname(value);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const want = `${base.toLowerCase()}.`;
  const matches = entries.filter((entry) => {
    if (!entry.toLowerCase().startsWith(want)) return false;
    return /^[A-Za-z0-9]{1,5}$/.test(entry.slice(want.length));
  });
  if (matches.length === 0) return null;
  const pick = matches.find((entry) => hasMediaExtension(entry)) ?? matches[0];
  return dir === '.' ? pick : join(dir, pick);
}

/** `12_345_678` → `11.8 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Storage answers a failed PUT with an XML `<Error><Code>…</Code><Message>…</Message>`. */
export function storageErrorReason(body: string): string | undefined {
  const code = /<Code>([^<]*)<\/Code>/i.exec(body)?.[1]?.trim();
  const message = /<Message>([^<]*)<\/Message>/i.exec(body)?.[1]?.trim();
  const reason = [code, message].filter(Boolean).join(': ');
  if (!reason) return undefined;
  return reason.length > 300 ? `${reason.slice(0, 299)}…` : reason;
}

/** `fetch failed` says nothing; its `cause` (ECONNRESET, other side closed…) does. */
function networkReason(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const parts = [cause?.code, cause?.message].filter(Boolean);
  if (parts.length > 0) return [...new Set(parts)].join(' ');
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

export interface UploadLocalFileOptions {
  /** Where the `Uploading <name> (<size>)…` line goes. Default: stderr, so --json stdout stays clean. */
  onProgress?: (line: string) => void;
  /** The storage PUT. Tests pass a stub; the CLI uses the global fetch. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * The file's bytes as a Blob BACKED BY THE FILE (`fs.openAsBlob`), so a 2 GB
 * clip streams from disk instead of being read into memory — and fetch still
 * sends an exact Content-Length, which the signed PUT needs. Re-readable, so
 * the retry sends the same bytes.
 */
async function fileBody(path: string, contentType: string): Promise<Blob> {
  // Namespace lookup, not a named import: a named import of an export the
  // running Node lacks fails the whole CLI at load time.
  if (typeof fs.openAsBlob === 'function') return (await fs.openAsBlob(path, { type: contentType })) as Blob;
  return new Blob([await readFile(path)], { type: contentType });
}

/**
 * Upload one local file and return the SDK's `Upload` (asset_url etc.).
 * Size-checked before anything is sent, typed by extension, PUT retried once on
 * a network drop or a 5xx, and every failure a CliError naming the file.
 */
export async function uploadLocalFile(
  client: Pick<GenFireClient, 'createUpload'>,
  path: string,
  options: UploadLocalFileOptions = {}
): Promise<Upload> {
  const progress = options.onProgress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fetchImpl = options.fetchImpl ?? fetch;
  const name = basename(path);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
    const sibling = findExtensionSibling(path);
    throw new CliError(`File not found: ${path}${sibling ? ` — did you mean ${sibling}?` : ''}`, 'file_not_found');
  }

  if (size === 0) {
    throw new CliError(`${name} is empty (0 bytes) — nothing to upload.`, 'upload_empty');
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new CliError(
      `${name} is ${formatBytes(size)}; uploads are limited to 5 GB. Trim or compress it first.`,
      'upload_too_large'
    );
  }

  const contentType = contentTypeForPath(path);
  progress(`Uploading ${name} (${formatBytes(size)})…`);
  const upload = await client.createUpload(
    { filename: name, content_type: contentType, size_bytes: size },
    { signal: options.signal }
  );

  // The PUT must carry the content type the URL was signed for — the one the
  // API echoes back, not our guess (they match unless the API normalised it).
  const body = await fileBody(path, upload.content_type);
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(upload.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': upload.content_type },
        body,
        signal: options.signal
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      if (attempt < maxAttempts) {
        progress(`Upload of ${name} was interrupted (${networkReason(err)}) — retrying once…`);
        continue;
      }
      throw new CliError(
        `Upload of ${name} failed: network error (${networkReason(err)}). Check your connection and try again.`,
        'upload_failed'
      );
    }

    if (response.ok) return upload;

    const text = await response.text().catch(() => '');
    if (response.status >= 500 && attempt < maxAttempts) {
      progress(`Upload of ${name} got HTTP ${response.status} from storage — retrying once…`);
      continue;
    }
    const reason = storageErrorReason(text);
    throw new CliError(
      `Upload of ${name} failed: HTTP ${response.status}${reason ? ` (${reason})` : ''}.`,
      'upload_failed'
    );
  }
  // Unreachable: every iteration returns, continues or throws.
  throw new CliError(`Upload of ${name} failed.`, 'upload_failed');
}
