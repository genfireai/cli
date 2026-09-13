import { GenFireClient } from '@genfire/sdk';
import { readConfig, resolveApiKey, resolveBaseUrl } from './config.js';
import { CliError } from './errors.js';

export async function createClient(): Promise<GenFireClient> {
  const config = await readConfig();
  const auth = await resolveApiKey();

  if (!auth) {
    throw new CliError(
      'Not authenticated. Run `genfire auth login` or set GENFIRE_API_KEY.',
      'not_authenticated'
    );
  }

  return new GenFireClient({
    apiKey: auth.apiKey,
    baseUrl: resolveBaseUrl(config)
  });
}

/**
 * Call a /v1 endpoint the SDK does not expose yet.
 *
 * The SDK's own `request` is private and the published package lags the API by
 * a release, so a command for a brand-new endpoint would otherwise have to wait
 * for an SDK cut. Same auth and base-url resolution as `createClient`; errors
 * come back as CliError carrying the API's own `code` and `detail`. Pass
 * `idempotencyKey` for any route the API gates on an `Idempotency-Key` header.
 */
export async function publicApiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {}
): Promise<T> {
  const config = await readConfig();
  const auth = await resolveApiKey();

  if (!auth) {
    throw new CliError(
      'Not authenticated. Run `genfire auth login` or set GENFIRE_API_KEY.',
      'not_authenticated'
    );
  }

  const baseUrl = resolveBaseUrl(config).replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.apiKey}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      // Routes behind `requireIdempotencyKey` read the HEADER and nothing else:
      // a body field called `idempotency_key` is ignored and the submit 400s
      // `idempotency_key_required`. Same contract the SDK fills in from its
      // `{ idempotencyKey }` request option, which is how every other submit
      // command in this CLI sends it.
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });

  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new CliError(
      String(parsed?.detail || parsed?.title || text || `Request failed with ${response.status}`),
      String(parsed?.code || 'request_failed')
    );
  }

  return parsed as T;
}
