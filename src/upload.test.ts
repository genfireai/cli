import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateUploadRequest, Upload } from '@genfire/sdk';
import { contentTypeForPath, findExtensionSibling, MAX_UPLOAD_BYTES, uploadLocalFile } from './upload.js';

// The pinned SDK's uploadFile sent no content type (the API then stored every
// file as application/octet-stream), failed as "Upload PUT failed with status
// N." with no file name or reason, and never retried a dropped connection.
// These pin the CLI's own upload path.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'genfire-upload-'));
}

function fakeClient() {
  const created: CreateUploadRequest[] = [];
  const client = {
    async createUpload(input: CreateUploadRequest): Promise<Upload> {
      created.push(input);
      return {
        asset_id: 'asset_1',
        upload_url: 'https://storage.example/put/asset_1',
        asset_url: 'https://cdn.example/asset_1',
        content_type: input.content_type ?? 'application/octet-stream',
        expires_at: '2026-10-20T00:00:00.000Z'
      };
    }
  };
  return { client, created };
}

function fetchQueue(steps: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra PUT');
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const networkDrop = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'read ECONNRESET' } });

test('content type comes from the extension, any case', () => {
  assert.equal(contentTypeForPath('IMG_1234.MOV'), 'video/quicktime');
  assert.equal(contentTypeForPath('/a/b/me.JPG'), 'image/jpeg');
  assert.equal(contentTypeForPath('clip.webm'), 'video/webm');
  assert.equal(contentTypeForPath('voice.m4a'), 'audio/mp4');
  assert.equal(contentTypeForPath('notes'), undefined);
  assert.equal(contentTypeForPath('weird.constructor'), undefined, 'never an Object.prototype key');
});

test('uploadLocalFile sends the content type and size, prints progress to the sink, and returns the upload', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'IMG_1234.MOV');
    writeFileSync(path, Buffer.alloc(2048, 1));
    const { client, created } = fakeClient();
    const { calls, fetchImpl } = fetchQueue([new Response('', { status: 200 })]);
    const lines: string[] = [];
    const upload = await uploadLocalFile(client, path, { fetchImpl, onProgress: (l) => lines.push(l) });
    assert.equal(upload.asset_url, 'https://cdn.example/asset_1');
    assert.deepEqual(created, [{ filename: 'IMG_1234.MOV', content_type: 'video/quicktime', size_bytes: 2048 }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal((calls[0].init.headers as Record<string, string>)['Content-Type'], 'video/quicktime');
    assert.deepEqual(lines, ['Uploading IMG_1234.MOV (2.0 KB)…']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dropped connection is retried once, then succeeds', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'me.png');
    writeFileSync(path, 'png');
    const { client } = fakeClient();
    const { calls, fetchImpl } = fetchQueue([networkDrop(), new Response('', { status: 200 })]);
    const lines: string[] = [];
    await uploadLocalFile(client, path, { fetchImpl, onProgress: (l) => lines.push(l) });
    assert.equal(calls.length, 2);
    assert.match(lines[1], /me\.png was interrupted \(ECONNRESET read ECONNRESET\) — retrying once/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a 5xx is retried once; the final failure names the file, the status and the storage reason', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'clip.mp4');
    writeFileSync(path, 'mp4');
    const { client } = fakeClient();
    const xml = "<?xml version='1.0' encoding='UTF-8'?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match.</Message></Error>";
    const { calls, fetchImpl } = fetchQueue([new Response('oops', { status: 503 }), new Response(xml, { status: 403 })]);
    await assert.rejects(
      uploadLocalFile(client, path, { fetchImpl, onProgress: () => {} }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'upload_failed');
        assert.equal(err.message, 'Upload of clip.mp4 failed: HTTP 403 (SignatureDoesNotMatch: The request signature we calculated does not match.).');
        return true;
      }
    );
    assert.equal(calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a 4xx is not retried, and two network drops fail with the cause', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'clip.mp4');
    writeFileSync(path, 'mp4');
    const { client } = fakeClient();
    const denied = fetchQueue([new Response('', { status: 400 })]);
    await assert.rejects(uploadLocalFile(client, path, { fetchImpl: denied.fetchImpl, onProgress: () => {} }), /Upload of clip\.mp4 failed: HTTP 400\.$/);
    assert.equal(denied.calls.length, 1);

    const dropped = fetchQueue([networkDrop(), networkDrop()]);
    await assert.rejects(
      uploadLocalFile(client, path, { fetchImpl: dropped.fetchImpl, onProgress: () => {} }),
      /Upload of clip\.mp4 failed: network error \(ECONNRESET read ECONNRESET\)/
    );
    assert.equal(dropped.calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('size is checked before anything is sent: empty, and over the 5 GB API maximum', async () => {
  const dir = scratch();
  try {
    const { client, created } = fakeClient();
    const empty = join(dir, 'empty.mp4');
    writeFileSync(empty, '');
    await assert.rejects(uploadLocalFile(client, empty, { onProgress: () => {} }), /empty\.mp4 is empty/);

    // Sparse: no 5 GB actually written.
    const huge = join(dir, 'huge.mov');
    writeFileSync(huge, '');
    truncateSync(huge, MAX_UPLOAD_BYTES + 1);
    await assert.rejects(
      uploadLocalFile(client, huge, { onProgress: () => {} }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'upload_too_large');
        assert.match(err.message, /huge\.mov is 5\.0 GB; uploads are limited to 5 GB/);
        return true;
      }
    );
    assert.equal(created.length, 0, 'no upload slot is requested for a file that cannot be sent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file names its hidden-extension sibling', async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'IMG_1234.MOV'), 'x');
    writeFileSync(join(dir, 'IMG_1234.AAE'), 'x');
    assert.equal(findExtensionSibling(join(dir, 'IMG_1234')), join(dir, 'IMG_1234.MOV'), 'the media sibling wins');
    assert.equal(findExtensionSibling(join(dir, 'img_1234')), join(dir, 'IMG_1234.MOV'), 'any case');
    assert.equal(findExtensionSibling(join(dir, 'IMG_9999')), null);
    assert.equal(findExtensionSibling(join(dir, 'IMG_1234.mp4')), null, 'a value with an extension is not guessed at');
    const { client } = fakeClient();
    await assert.rejects(
      uploadLocalFile(client, join(dir, 'IMG_1234'), { onProgress: () => {} }),
      new RegExp(`File not found: .*IMG_1234 — did you mean .*IMG_1234\\.MOV\\?`)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
