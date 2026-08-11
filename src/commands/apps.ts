import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { cyan, dim, green, printResult } from '../output.js';
import { resolveMediaInput, waitForRun } from '../runHelpers.js';

function parseKind(value: string | undefined): 'app' | 'website' | undefined {
  if (!value) return undefined;
  if (value !== 'app' && value !== 'website') {
    throw new CliError(`Invalid --kind: ${value}. Use app or website.`, 'invalid_kind');
  }
  return value;
}

function parseMinutes(value: string, flag: string): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new CliError(`Invalid ${flag}: ${value}`, 'invalid_wait_timeout');
  }
  return minutes * 60 * 1000;
}

/** Report the app_id / live_url a completed apps run puts on its output. */
function reportApp(output: Record<string, unknown> | null, runId: string): void {
  const appId = output?.app_id ? String(output.app_id) : '';
  const liveUrl = output?.live_url ? String(output.live_url) : '';
  if (appId) process.stdout.write(`${dim('App ID:')}  ${appId}\n`);
  if (liveUrl) process.stdout.write(`${dim('Live:')}    ${cyan(liveUrl)}\n`);
  if (!appId && !liveUrl) {
    process.stdout.write(`${dim('Run:')}     ${runId}\n`);
  }
  if (appId) {
    process.stdout.write(`${dim('Publish with:')} genfire apps publish ${appId}\n`);
  }
}

export function registerAppsCommand(program: Command): void {
  const apps = program
    .command('apps')
    .description('Build, deploy, and publish single-file apps and websites');

  apps
    .command('create <prompt>')
    .description('Build an app or website from a prompt. Billable; takes a few minutes.')
    .option('--kind <kind>', 'app (default) or website')
    .option('--app-id <id>', 'Iterate on an existing app instead of creating a new one')
    .option('--high-quality', 'Spend more tokens for a higher-fidelity build')
    .option('-m, --model <model>', 'Authoring model override')
    .option('--asset <urlOrPath...>', 'Up to 16 assets the build may reference')
    .option('--no-wait', "Don't wait for the build; print the queued run and exit")
    .option('--wait-timeout <minutes>', 'Maximum minutes to wait', '10')
    .action(async (prompt: string, opts: {
      kind?: string; appId?: string; highQuality?: boolean; model?: string;
      asset?: string[]; wait: boolean; waitTimeout: string;
    }) => {
      if (opts.asset && opts.asset.length > 16) {
        throw new CliError('--asset accepts at most 16 files.', 'too_many_assets');
      }
      const client = await createClient();

      const assetUrls: string[] = [];
      for (const asset of opts.asset || []) {
        assetUrls.push((await resolveMediaInput(client, asset)).url);
      }

      const run = await client.createAppGeneration(
        {
          prompt,
          kind: parseKind(opts.kind),
          app_id: opts.appId,
          high_quality: opts.highQuality,
          model: opts.model,
          asset_urls: assetUrls.length ? assetUrls : undefined
        },
        { idempotencyKey: randomUUID() }
      );

      if (!opts.wait) {
        printResult(run, () => {
          process.stdout.write(`${dim('Build queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
          process.stdout.write(`${dim('Re-check with:')} genfire runs get ${run.id}\n`);
        });
        return;
      }

      process.stderr.write(`${dim(`Building… (run ${run.id})`)}\n`);
      const completed = await waitForRun(client, run.id, {
        timeoutMs: parseMinutes(opts.waitTimeout, '--wait-timeout')
      });

      if (completed.status !== 'completed') {
        throw new CliError(
          completed.error?.message || `Build ${completed.status}.`,
          completed.error?.code || 'build_failed'
        );
      }
      printResult(completed, () => {
        process.stdout.write(`${green('✓')} Build complete\n`);
        reportApp(completed.output, completed.id);
      });
    });

  apps
    .command('deploy')
    .description('Deploy HTML you already have — skips generation and hosts it at a permanent URL')
    .requiredOption('-f, --file <path>', 'A complete single-file HTML document (≤1.5MB)')
    .option('-t, --title <title>', 'App title')
    .option('--brief <text>', 'Short description of what this is')
    .option('--kind <kind>', 'app (default) or website')
    .option('--app-id <id>', 'Redeploy over an existing app')
    .option('--no-wait', "Don't wait for the deploy; print the queued run and exit")
    .option('--wait-timeout <minutes>', 'Maximum minutes to wait', '5')
    .action(async (opts: {
      file: string; title?: string; brief?: string; kind?: string; appId?: string;
      wait: boolean; waitTimeout: string;
    }) => {
      let html: string;
      try {
        html = await readFile(opts.file, 'utf8');
      } catch (err) {
        throw new CliError(`Could not read --file ${opts.file}: ${(err as Error).message}`, 'invalid_html_file');
      }

      const trimmed = html.trim();
      if (!/^<!doctype html|^<html/i.test(trimmed) || !/<\/html>$/i.test(trimmed)) {
        throw new CliError(
          'The file must be one complete HTML document: starting with <!DOCTYPE html> or <html> and ending with </html>.',
          'incomplete_html'
        );
      }
      const bytes = Buffer.byteLength(html, 'utf8');
      if (bytes > 1_500_000) {
        throw new CliError(
          `HTML is ${(bytes / 1_000_000).toFixed(2)}MB; the limit is 1.5MB. Load large libraries from a CDN instead of inlining them.`,
          'html_too_large'
        );
      }

      const client = await createClient();
      const run = await client.deployApp(
        {
          html,
          title: opts.title,
          brief: opts.brief,
          kind: parseKind(opts.kind),
          app_id: opts.appId
        },
        { idempotencyKey: randomUUID() }
      );

      if (!opts.wait) {
        printResult(run, () => {
          process.stdout.write(`${dim('Deploy queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
          process.stdout.write(`${dim('Re-check with:')} genfire runs get ${run.id}\n`);
        });
        return;
      }

      process.stderr.write(`${dim('Deploying (the page is smoke-booted before it goes live)…')}\n`);
      const completed = await waitForRun(client, run.id, {
        timeoutMs: parseMinutes(opts.waitTimeout, '--wait-timeout')
      });

      if (completed.status !== 'completed') {
        const code = completed.error?.code || 'deploy_failed';
        const hint = code === 'boot_failed'
          ? ' The page threw on load — fix the code and deploy again.'
          : '';
        throw new CliError((completed.error?.message || `Deploy ${completed.status}.`) + hint, code);
      }
      printResult(completed, () => {
        process.stdout.write(`${green('✓')} Deployed\n`);
        reportApp(completed.output, completed.id);
      });
    });

  apps
    .command('publish <appId>')
    .description('Make a completed app publicly visible')
    .action(async (appId: string) => {
      const client = await createClient();
      const result = await client.publishApp(appId, true);
      printResult(result, () => {
        process.stdout.write(`${green('✓')} Published ${result.id}\n`);
      });
    });

  apps
    .command('unpublish <appId>')
    .description('Make an app private again')
    .action(async (appId: string) => {
      const client = await createClient();
      const result = await client.publishApp(appId, false);
      printResult(result, () => {
        process.stdout.write(`${dim('✓')} Unpublished ${result.id}\n`);
      });
    });
}
