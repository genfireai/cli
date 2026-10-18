import { GenFireApiError, getCliAuthSession } from '@genfire/sdk';
import type { FetchLike } from '@genfire/sdk';

/**
 * How often `genfire auth login` (and the TUI's /login) asks whether the
 * browser approved yet. Binaries up to 0.23 polled every 2 s — 30 requests a
 * minute against a status route that then shared the 20/min OAuth token
 * bucket, so any approval slower than ~40 s answered 429 and killed the login.
 */
export const CLI_AUTH_POLL_INTERVAL_MS = 5000;
/** How long a login waits for the browser: the server's session lifetime. */
export const CLI_AUTH_POLL_MAX_MS = 10 * 60 * 1000;
/** The wait after a 429 that names no Retry-After, or after a transient failure. */
export const CLI_AUTH_RETRY_BACKOFF_MS = 10_000;

export type CliAuthPollResult = 'approved' | 'denied' | 'expired';

export interface CliAuthPollRetry {
  reason: 'rate_limited' | 'transient';
  waitMs: number;
  /** 1 on the first failure of a streak; a successful read resets it. */
  consecutiveFailures: number;
  error: unknown;
}

export interface CliAuthPollOptions {
  baseUrl: string;
  intervalMs?: number;
  timeoutMs?: number;
  /** Called once, on the first `pending` answer. */
  onPending?: () => void;
  /** Called before each wait a throttle or a transient failure causes. */
  onRetry?: (retry: CliAuthPollRetry) => void;
  /** Seams for the tests: transport, clock and timer. */
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** `Retry-After` as milliseconds from now — delta-seconds or an HTTP date. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  const value = String(header ?? '').trim();
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * Which failures mean "wait and ask again" rather than "the login is over".
 * A 429 or 5xx is the server's state, not the session's; a TypeError is
 * fetch's network failure and a SyntaxError a proxy's non-JSON error page.
 * Everything else — 404 above all — still ends the login as it always has.
 */
function retryReason(error: unknown): CliAuthPollRetry['reason'] | null {
  if (error instanceof GenFireApiError) {
    if (error.status === 429) return 'rate_limited';
    return error.status >= 500 ? 'transient' : null;
  }
  return error instanceof TypeError || error instanceof SyntaxError ? 'transient' : null;
}

/**
 * Poll `GET /cli/auth/sessions/:id` until the browser approves or denies, or
 * the session runs out. Throttles and blips are waited out up to the deadline
 * instead of thrown: the session is still good, and throwing made the user
 * start over after they had already clicked Approve.
 */
export async function pollCliAuthSession(sessionId: string, options: CliAuthPollOptions): Promise<CliAuthPollResult> {
  const intervalMs = options.intervalMs ?? CLI_AUTH_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? CLI_AUTH_POLL_MAX_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const baseFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  // The SDK's error carries no headers, so the transport keeps the last
  // response's Retry-After for the 429 branch below.
  const last = { retryAfter: null as string | null };
  const recordingFetch: FetchLike = async (input, init) => {
    const response = await baseFetch(input, init);
    last.retryAfter = response.headers.get('retry-after');
    return response;
  };

  const deadline = now() + timeoutMs;
  let announcedPending = false;
  let consecutiveFailures = 0;

  while (now() < deadline) {
    let waitMs = intervalMs;
    last.retryAfter = null;
    try {
      const session = await getCliAuthSession(sessionId, { baseUrl: options.baseUrl, fetch: recordingFetch });
      consecutiveFailures = 0;
      if (session.status === 'approved' || session.status === 'denied' || session.status === 'expired') {
        return session.status;
      }
      if (session.status === 'pending' && !announcedPending) {
        announcedPending = true;
        options.onPending?.();
      }
    } catch (error) {
      const reason = retryReason(error);
      if (!reason) throw error;
      consecutiveFailures += 1;
      const hinted = reason === 'rate_limited' ? parseRetryAfterMs(last.retryAfter, now()) : null;
      waitMs = Math.max(intervalMs, hinted ?? CLI_AUTH_RETRY_BACKOFF_MS);
      options.onRetry?.({ reason, waitMs, consecutiveFailures, error });
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(waitMs, remaining));
  }
  // The last wait ran up to the deadline (a long Retry-After is capped to it):
  // an approval that landed during it must not be reported as expired. One
  // best-effort look, never retried.
  try {
    const session = await getCliAuthSession(sessionId, { baseUrl: options.baseUrl, fetch: recordingFetch });
    if (session.status === 'approved' || session.status === 'denied') return session.status;
  } catch {
    // Gone or still throttled: expired either way.
  }
  return 'expired';
}
