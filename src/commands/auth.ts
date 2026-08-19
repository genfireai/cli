import { Command } from 'commander';
import {
  GenFireApiError,
  GenFireClient,
  exchangeCliAuthSession,
  getCliAuthSession,
  startCliAuthSession
} from '@genfire/sdk';
import { CliError } from '../errors.js';
import { readConfig, resolveApiKey, resolveBaseUrl } from '../config.js';
import { deleteCredentials, getFallbackPath, isUsingKeychain, saveCredentials } from '../credentials.js';
import { generatePkcePair } from '../pkce.js';
import { VERSION, checkLatestVersion } from '../versionCheck.js';
import { bold, cyan, dim, green, printResult, red, yellow } from '../output.js';

const CLI_CLIENT_ID = 'genfire-cli';
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 10 * 60 * 1000;

/**
 * Scopes the CLI requests by default during browser auth. We intentionally
 * ask for the full generation surface so users don't hit "scope missing"
 * errors when they switch from `generate image` to `generate video`. Users
 * can still mint narrower keys manually via the dashboard.
 */
const CLI_DEFAULT_SCOPES = [
  'account:read',
  'credits:read',
  'models:read',
  'runs:read',
  'webhooks:read',
  'webhooks:write',
  'images:write',
  'videos:write',
  'audio:write',
  'lipsync:write',
  'products:write',
  'workflows:read',
  'workflows:write',
  'reels:read',
  'reels:write',
  'social:read',
  'social:write',
  'batches:read',
  'batches:write',
  'uploads:write',
  'influencers:read',
  'influencers:write',
  'elements:read',
  'elements:write',
  'brands:read',
  'brands:write',
  'moodboards:read',
  'marketing:read',
  'teams:read'
] as const;

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

function deviceLabel(): string {
  const host = (process.env.HOSTNAME || process.env.COMPUTERNAME || '').trim();
  const date = new Date().toISOString().slice(0, 10);
  return host ? `genfire-cli (${host}, ${date})` : `genfire-cli (${date})`;
}

async function pollUntilTerminal(sessionId: string, baseUrl: string): Promise<'approved' | 'denied' | 'expired'> {
  const startedAt = Date.now();
  let lastStatus = '';
  while (Date.now() - startedAt < POLL_MAX_MS) {
    const status = await getCliAuthSession(sessionId, { baseUrl });
    if (status.status !== lastStatus) {
      if (status.status === 'pending' && lastStatus !== 'pending') {
        process.stderr.write(`${dim('Waiting for approval...')}\n`);
      }
      lastStatus = status.status;
    }
    if (status.status === 'approved') return 'approved';
    if (status.status === 'denied') return 'denied';
    if (status.status === 'expired') return 'expired';
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return 'expired';
}

async function validateKey(apiKey: string, baseUrl: string): Promise<{ accountId: string; email: string | null }> {
  const probe = new GenFireClient({ apiKey, baseUrl });
  try {
    const account = await probe.getAccount();
    return { accountId: account.id, email: account.email ?? null };
  } catch (err) {
    if (err instanceof GenFireApiError && err.status === 401) {
      throw new CliError('API key was rejected by the server.', 'invalid_api_key');
    }
    throw err;
  }
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage Genfire CLI authentication');

  auth
    .command('login')
    .description('Authenticate with Genfire via your web browser')
    .option('--api-key <key>', 'Skip the browser flow and store this API key directly')
    .option('--no-browser', "Don't try to open the browser; just print the URL")
    .option('--label <label>', 'Display label for the issued API key', deviceLabel())
    .action(async (options: { apiKey?: string; browser: boolean; label: string }) => {
      const config = await readConfig();
      const baseUrl = resolveBaseUrl(config);

      if (options.apiKey) {
        const { accountId, email } = await validateKey(options.apiKey.trim(), baseUrl);
        const stored = await saveCredentials({
          apiKey: options.apiKey.trim(),
          label: options.label || 'genfire-cli (manual)'
        });
        printResult(
          { ok: true, account_id: accountId, email, storage: stored.backend, storage_path: stored.path },
          () => {
            process.stderr.write(
              `${green('Logged in.')} ${dim(`(${email || accountId})`)}\n` +
              `${dim('Storage:')} ${stored.backend}${stored.path ? ` (${stored.path})` : ''}\n`
            );
          }
        );
        return;
      }

      const pkce = generatePkcePair();
      const start = await startCliAuthSession({
        clientId: CLI_CLIENT_ID,
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
        label: options.label,
        scopes: CLI_DEFAULT_SCOPES as unknown as Parameters<typeof startCliAuthSession>[0]['scopes'],
        baseUrl
      });

      const opened = options.browser !== false ? await tryOpenBrowser(start.verification_url) : false;
      if (opened) {
        process.stderr.write(`${dim('Opened browser to')} ${cyan(start.verification_url)}\n`);
      } else {
        process.stderr.write(
          `${bold('Open this URL in your browser to authorize the CLI:')}\n` +
          `${cyan(start.verification_url)}\n\n`
        );
      }

      const result = await pollUntilTerminal(start.session_id, baseUrl);

      if (result === 'denied') {
        throw new CliError('Authorization was denied in the browser.', 'auth_denied');
      }
      if (result === 'expired') {
        throw new CliError('Login session expired. Run `genfire auth login` again.', 'auth_expired');
      }

      const exchanged = await exchangeCliAuthSession({
        sessionId: start.session_id,
        codeVerifier: pkce.codeVerifier,
        baseUrl
      });

      const { accountId, email } = await validateKey(exchanged.api_key, baseUrl);

      const stored = await saveCredentials({
        apiKey: exchanged.api_key,
        label: exchanged.label,
        scopes: exchanged.scopes,
        baseUrl
      });

      printResult(
        {
          ok: true,
          account_id: accountId,
          email,
          label: exchanged.label,
          scopes: exchanged.scopes,
          storage: stored.backend,
          storage_path: stored.path
        },
        () => {
          process.stderr.write(
            `${green('Logged in.')} ${dim(`(${email || accountId})`)}\n` +
            `${dim('Issued key:')} ${exchanged.label}\n` +
            `${dim('Storage:')}    ${stored.backend}${stored.path ? ` (${stored.path})` : ''}\n` +
            `${dim('Scopes:')}     ${exchanged.scopes.join(', ')}\n`
          );
          if (stored.backend === 'file') {
            process.stderr.write(
              `${yellow('Heads up:')} OS keychain unavailable, key stored on disk at ${stored.path} (chmod 600).\n`
            );
          }
        }
      );

      // Best-effort version check. If we're behind the latest release, surface
      // it now so users on a stale build know to upgrade — common cause of
      // "missing scope" errors when the CLI added new defaults in a patch.
      const versionCheck = await checkLatestVersion(VERSION);
      if (versionCheck?.isOutdated) {
        process.stderr.write(
          `${yellow('Update available:')} CLI v${versionCheck.installed} installed, v${versionCheck.latest} available.\n` +
          `${dim('Run')} npm install -g @genfire/cli@latest ${dim('to upgrade — newer versions may grant additional scopes by default.')}\n`
        );
      }
    });

  auth
    .command('logout')
    .description('Remove stored credentials')
    .action(async () => {
      await deleteCredentials();
      printResult({ ok: true }, () => {
        process.stderr.write(
          `${green('Logged out.')}\n` +
          `${dim('Stored credentials cleared from keychain and')} ${getFallbackPath()}\n`
        );
      });
    });

  auth
    .command('status')
    .description('Show the current authentication state')
    .action(async () => {
      const config = await readConfig();
      const baseUrl = resolveBaseUrl(config);
      const auth = await resolveApiKey();

      if (!auth) {
        printResult(
          { authenticated: false },
          () => {
            process.stderr.write(`${red('Not authenticated.')}\n`);
            process.stderr.write(`${dim('Run')} genfire auth login\n`);
          }
        );
        process.exitCode = 1;
        return;
      }

      const usingKeychain = auth.source === 'stored' ? await isUsingKeychain() : false;
      const source = auth.source === 'env'
        ? 'env:GENFIRE_API_KEY'
        : usingKeychain
        ? 'keychain'
        : `file:${getFallbackPath()}`;

      try {
        const { accountId, email } = await validateKey(auth.apiKey, baseUrl);
        printResult(
          { authenticated: true, account_id: accountId, email, source, base_url: baseUrl },
          () => {
            process.stderr.write(
              `${green('Authenticated')} ${dim(`(${email || accountId})`)}\n` +
              `${dim('Source:')}  ${source}\n` +
              `${dim('API URL:')} ${baseUrl}\n`
            );
          }
        );
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError(`Auth check failed: ${(err as Error).message}`, 'auth_check_failed');
      }
    });
}
