import { Command } from 'commander';
import { GenFireApiError } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, red, yellow } from '../output.js';
import { join } from 'node:path';
import { downloadOutputs, extractOutputUrls, waitForRun } from '../runHelpers.js';

function statusColor(status: string): string {
  if (status === 'completed') return green(status);
  if (status === 'failed') return red(status);
  if (status === 'queued' || status === 'processing') return yellow(status);
  return status;
}

function parseDurationMs(value: string, flag: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) throw new CliError(`Invalid duration for ${flag}: ${value}`, 'invalid_duration');
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms') return Math.max(1, Math.round(amount));
  if (unit === 'm') return Math.round(amount * 60 * 1000);
  return Math.round(amount * 1000);
}

export function registerRunsCommand(program: Command): void {
  const runs = program.command('runs').description('Inspect previous runs');

  runs
    .command('list')
    .description('List or search past runs')
    // --search is a FULL-history search (server-side), not a filter over the
    // page: --limit bounds the results, never how far back it looks.
    .option('-q, --search <keyword>', 'Search all history by prompt, topic, title, model or kind (all words must match)')
    .option('-s, --status <status>', 'Filter by status: queued, processing, completed, failed')
    .option('-c, --capability <capability>', 'Filter by capability, e.g. image_generation')
    .option('--since <date>', 'Only runs created on/after this ISO date, e.g. 2026-03-01')
    .option('--until <date>', 'Only runs created on/before this ISO date')
    .option('--cursor <cursor>', 'Continue from a previous page (its next_cursor)')
    .option('--team <teamId>', 'Only runs billed to this workspace pool — what the team has made')
    .option('--project <projectId>', 'Only runs filed into this project — what is in this folder')
    .option('--app <app>', 'Only runs made in one product surface, e.g. marketing-studio')
    .option('-l, --limit <n>', 'Max runs to return', '25')
    .action(async (opts: {
      search?: string;
      status?: string;
      capability?: string;
      since?: string;
      until?: string;
      cursor?: string;
      team?: string;
      project?: string;
      app?: string;
      limit: string;
    }) => {
      const client = await createClient();
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError('--limit must be an integer 1-100', 'invalid_limit');
      }
      const validStatuses = new Set(['queued', 'processing', 'completed', 'failed']);
      if (opts.status && !validStatuses.has(opts.status)) {
        throw new CliError(`Invalid --status: ${opts.status}`, 'invalid_status');
      }
      for (const [flag, value] of [['--since', opts.since], ['--until', opts.until]] as const) {
        if (value && Number.isNaN(new Date(value).getTime())) {
          throw new CliError(`${flag} must be an ISO date, e.g. 2026-03-01`, 'invalid_date');
        }
      }

      const response = await client.listRuns({
        status: opts.status as ('queued' | 'processing' | 'completed' | 'failed') | undefined,
        capability: opts.capability,
        limit,
        q: opts.search,
        starting_after: opts.cursor,
        created_after: opts.since,
        created_before: opts.until,
        // Not on the pinned SDK's ListRunsParams yet — see the scopeFields note
        // in commands/generate.ts. The API filters on both today.
        ...(opts.team ? { team_id: opts.team } : {}),
        ...(opts.project ? { project_id: opts.project } : {}),
        ...(opts.app ? { app: opts.app } : {})
      } as any);

      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim(opts.search ? 'No runs match that search.' : 'No runs match.')}\n`);
        } else {
          printTable(
            response.data.map((run) => ({
              id: run.id,
              status: statusColor(run.status),
              capability: run.capability,
              model: run.model || '',
              created: run.created_at.replace('T', ' ').slice(0, 19)
            })),
            ['id', 'status', 'capability', 'model', 'created']
          );
        }
        if (response.has_more && response.next_cursor) {
          const through = response.scanned_through
            ? ` (searched back to ${response.scanned_through.slice(0, 10)})`
            : '';
          process.stdout.write(`${dim(`More runs${through} — continue with --cursor ${response.next_cursor}`)}\n`);
        }
      });
    });

  runs
    .command('get <runId>')
    .description('Show full details for a single run')
    .action(async (runId: string) => {
      const client = await createClient();
      try {
        const run = await client.getRun(runId);
        printResult(run, () => {
          process.stdout.write(`${bold(run.id)} ${dim(`(${statusColor(run.status)})`)}\n`);
          process.stdout.write(`${dim('Capability:')} ${run.capability}\n`);
          process.stdout.write(`${dim('Endpoint:')}   ${run.endpoint}\n`);
          if (run.model) process.stdout.write(`${dim('Model:')}      ${run.model}\n`);
          process.stdout.write(`${dim('Created:')}    ${run.created_at}\n`);
          if (run.completed_at) process.stdout.write(`${dim('Completed:')}  ${run.completed_at}\n`);
          if (run.error) {
            process.stdout.write(`${red('Error:')}      ${run.error.code}: ${run.error.message}\n`);
          }
          if (run.usage && Object.keys(run.usage).length > 0) {
            process.stdout.write(`${dim('Usage:')}\n`);
            for (const [key, value] of Object.entries(run.usage)) {
              process.stdout.write(`  ${dim(`${key}:`)} ${cyan(String(value))}\n`);
            }
          }
        });
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Run not found: ${runId}`, 'run_not_found');
        }
        throw err;
      }
    });

  runs
    .command('output <runId>')
    .description('Show or download the output of a completed run')
    .option('-o, --output <path>', 'Where to save the output(s); defaults to printing URLs only')
    .action(async (runId: string, opts: { output?: string }) => {
      const client = await createClient();
      const output = await client.getRunOutput(runId);
      if (output.status !== 'completed') {
        throw new CliError(`Run is ${output.status}; no output available yet.`, 'run_not_completed');
      }
      const run = await client.getRun(runId);
      const outputs = extractOutputUrls(run, run.capability);

      if (opts.output) {
        const written = await downloadOutputs(outputs, opts.output);
        printResult({ run_id: runId, downloaded_to: written, output: output.output }, () => {
          for (const path of written) {
            process.stderr.write(`${dim('Saved:')} ${path}\n`);
          }
        });
      } else {
        printResult({ run_id: runId, output: output.output, urls: outputs.map((entry) => entry.url) }, () => {
          if (outputs.length === 0) {
            process.stdout.write(`${dim('No output URLs found in this run.')}\n`);
            return;
          }
          for (const entry of outputs) {
            process.stdout.write(`${entry.url}\n`);
          }
        });
      }
    });

  runs
    .command('wait <runIds...>')
    .description('Wait for one or more queued runs to finish (e.g. ones started with --no-wait), then print or download their outputs')
    .option('-o, --output <path>', 'Directory to download completed outputs into (one subfolder per run when waiting on several)')
    .option('--wait-timeout <duration>', 'Maximum time to wait, e.g. 15m, 600s', '15m')
    .option('--wait-interval <duration>', 'Polling interval', '3s')
    .action(async (runIds: string[], opts: { output?: string; waitTimeout: string; waitInterval: string }) => {
      const client = await createClient();
      const intervalMs = parseDurationMs(opts.waitInterval, '--wait-interval');
      const timeoutMs = parseDurationMs(opts.waitTimeout, '--wait-timeout');
      process.stderr.write(`${dim(`Waiting on ${runIds.length} run${runIds.length === 1 ? '' : 's'}...`)}\n`);
      // In parallel: the slowest run bounds the wait, not the sum.
      const settled = await Promise.allSettled(
        runIds.map((id) => waitForRun(client, id, { intervalMs, timeoutMs }))
      );
      const results: Array<Record<string, unknown>> = [];
      for (const [i, outcome] of settled.entries()) {
        const id = runIds[i];
        if (outcome.status === 'rejected') {
          results.push({ id, status: 'unknown', error: (outcome.reason as Error)?.message ?? String(outcome.reason) });
          continue;
        }
        const run = outcome.value;
        const outputs = run.status === 'completed' ? extractOutputUrls(run, run.capability) : [];
        let downloaded: string[] | undefined;
        if (opts.output && outputs.length > 0) {
          const target = runIds.length > 1 ? join(opts.output, run.id) : opts.output;
          downloaded = await downloadOutputs(outputs, target);
        }
        results.push({
          id: run.id,
          status: run.status,
          capability: run.capability,
          urls: outputs.map((o) => o.url),
          ...(downloaded ? { downloaded_to: downloaded } : {}),
          ...(run.error ? { error: `${run.error.code}: ${run.error.message}` } : {})
        });
      }
      printResult({ object: 'list', data: results }, () => {
        for (const r of results) {
          process.stdout.write(`${bold(String(r.id))} ${statusColor(String(r.status))}\n`);
          if (r.error) process.stdout.write(`  ${red(String(r.error))}\n`);
          for (const url of (r.urls as string[] | undefined) ?? []) process.stdout.write(`  ${url}\n`);
          for (const path of (r.downloaded_to as string[] | undefined) ?? []) process.stdout.write(`  ${dim('Saved:')} ${path}\n`);
        }
      });
      if (results.some((r) => r.status !== 'completed')) process.exitCode = 1;
    });
}
