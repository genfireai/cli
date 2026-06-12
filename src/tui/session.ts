import {
  GenFireApiError,
  GenFireClient,
  exchangeCliAuthSession,
  getCliAuthSession,
  startCliAuthSession
} from '@genfire/sdk';
import { readConfig, resolveApiKey, resolveBaseUrl } from '../config.js';
import {
  deleteCredentials,
  getFallbackPath,
  isUsingKeychain,
  saveCredentials
} from '../credentials.js';
import { generatePkcePair } from '../pkce.js';
import { useTuiStore } from './store.js';

const CLI_CLIENT_ID = 'genfire-cli';
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 10 * 60 * 1000;

/** Mirror of CLI_DEFAULT_SCOPES in commands/auth.ts. Keep these in sync. */
const CLI_DEFAULT_SCOPES = [
  'account:read',
  'credits:read',
  'models:read',
  'runs:read',
  'images:write',
  'videos:write',
  'audio:write',
  'lipsync:write',
  'products:write',
  'workflows:read',
  'workflows:write',
  'reels:read',
  'reels:write',
  'batches:read',
  'batches:write',
  'uploads:write',
  'influencers:read'
] as const;

export interface LoginOptions {
  apiKey?: string;
  noBrowser?: boolean;
  label?: string;
  onMessage?: (text: string, kind?: 'info' | 'success' | 'error' | 'output' | 'system') => void;
}

function deviceLabel(): string {
  const host = (process.env.HOSTNAME || process.env.COMPUTERNAME || '').trim();
  const date = new Date().toISOString().slice(0, 10);
  return host ? `genfire-cli (${host}, ${date})` : `genfire-cli (${date})`;
}

async function tryOpenBrowser(url: string): Promise<boolean> {
  try {
    const mod = await import('open');
    const opener = (mod as unknown as { default?: (target: string) => Promise<unknown> }).default;
    if (!opener) return false;
    await opener(url);
    return true;
  } catch {
    return false;
  }
}

async function pollUntilTerminal(sessionId: string, baseUrl: string): Promise<'approved' | 'denied' | 'expired'> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_MAX_MS) {
    const status = await getCliAuthSession(sessionId, { baseUrl });
    if (status.status === 'approved') return 'approved';
    if (status.status === 'denied') return 'denied';
    if (status.status === 'expired') return 'expired';
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return 'expired';
}

async function validateKey(apiKey: string, baseUrl: string): Promise<{ accountId: string; email: string | null; displayName: string; plan: string; credits: number }> {
  const probe = new GenFireClient({ apiKey, baseUrl });
  const account = await probe.getAccount();
  const credits = await probe.getCredits();
  return {
    accountId: account.id,
    email: account.email ?? null,
    displayName: account.display_name || account.id,
    plan: account.plan,
    credits: credits.balance
  };
}

export async function applyAuthToStore(): Promise<void> {
  const config = await readConfig();
  const baseUrl = resolveBaseUrl(config);
  const auth = await resolveApiKey();
  const store = useTuiStore.getState();

  if (!auth) {
    store.setClient(null, 'none', baseUrl);
    store.setAccount(null);
    return;
  }

  const usingKeychain = auth.source === 'stored' ? await isUsingKeychain() : false;
  const source: 'env' | 'stored' = auth.source === 'env' ? 'env' : 'stored';

  try {
    const client = new GenFireClient({ apiKey: auth.apiKey, baseUrl });
    store.setClient(client, source, baseUrl);
    const probe = await validateKey(auth.apiKey, baseUrl);
    store.setAccount({
      id: probe.accountId,
      email: probe.email || '',
      displayName: probe.displayName,
      plan: probe.plan,
      credits: probe.credits
    });
  } catch (err) {
    store.setClient(null, source, baseUrl);
    store.setAccount(null);
    throw err;
  }
}

export async function refreshAccount(client: GenFireClient): Promise<void> {
  const [account, credits] = await Promise.all([client.getAccount(), client.getCredits()]);
  useTuiStore.getState().setAccount({
    id: account.id,
    email: account.email || '',
    displayName: account.display_name || account.id,
    plan: account.plan,
    credits: credits.balance
  });
}

export async function runLogin(options: LoginOptions = {}): Promise<void> {
  const log = options.onMessage ?? (() => {});
  const config = await readConfig();
  const baseUrl = resolveBaseUrl(config);

  if (options.apiKey) {
    const probe = await validateKey(options.apiKey.trim(), baseUrl);
    const stored = await saveCredentials({
      apiKey: options.apiKey.trim(),
      label: options.label || 'genfire-cli (manual)'
    });
    log(`Logged in as ${probe.email || probe.accountId}.`, 'success');
    log(`Storage: ${stored.backend}${stored.path ? ` (${stored.path})` : ''}`, 'info');
    await applyAuthToStore();
    return;
  }

  const pkce = generatePkcePair();
  let start;
  try {
    start = await startCliAuthSession({
      clientId: CLI_CLIENT_ID,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      label: options.label || deviceLabel(),
      scopes: CLI_DEFAULT_SCOPES as unknown as Parameters<typeof startCliAuthSession>[0]['scopes'],
      baseUrl
    });
  } catch (err) {
    if (err instanceof GenFireApiError && err.status === 401) {
      throw new Error(
        `The CLI auth endpoint isn't reachable at ${baseUrl}. ` +
        `If you're testing against a self-hosted backend, set GENFIRE_API_BASE_URL ` +
        `to a deployment that includes the /cli/auth/sessions endpoints.`
      );
    }
    throw err;
  }

  const opened = options.noBrowser !== true ? await tryOpenBrowser(start.verification_url) : false;
  if (opened) {
    log(`Opened browser to ${start.verification_url}`, 'info');
  } else {
    log(`Open this URL in your browser to authorize the CLI:`, 'info');
    log(start.verification_url, 'output');
  }

  const result = await pollUntilTerminal(start.session_id, baseUrl);
  if (result === 'denied') throw new Error('Authorization was denied in the browser.');
  if (result === 'expired') throw new Error('Login session expired. Try /login again.');

  const exchanged = await exchangeCliAuthSession({
    sessionId: start.session_id,
    codeVerifier: pkce.codeVerifier,
    baseUrl
  });
  const probe = await validateKey(exchanged.api_key, baseUrl);

  const stored = await saveCredentials({
    apiKey: exchanged.api_key,
    label: exchanged.label,
    scopes: exchanged.scopes,
    baseUrl
  });

  log(`Logged in as ${probe.email || probe.accountId}.`, 'success');
  log(`Issued key: ${exchanged.label}`, 'info');
  log(`Storage:    ${stored.backend}${stored.path ? ` (${stored.path})` : ''}`, 'info');
  if (stored.backend === 'file') {
    log(`Heads up: OS keychain unavailable, key stored on disk at ${stored.path}.`, 'info');
  }
  await applyAuthToStore();
}

export async function runLogout(): Promise<void> {
  await deleteCredentials();
  useTuiStore.getState().setClient(null, 'none', useTuiStore.getState().baseUrl);
  useTuiStore.getState().setAccount(null);
}
