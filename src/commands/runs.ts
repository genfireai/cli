import { Command } from 'commander';
import { GenFireApiError } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, red, yellow } from '../output.js';
import { downloadOutputs, extractOutputUrls } from '../runHelpers.js';

function statusColor(status: string): string {
  if (status === 'completed') return green(status);
  if (status === 'failed') return red(status);
  if (status === 'queued' || status === 'processing') return yellow(status);
  return status;
}

export function registerRunsCommand(program: Command): void {
  const runs = program.command('runs').description('Inspect previous runs');

  runs
    .command('list')
    .description('List recent runs')
    .option('-s, --status <status>', 'Filter by status: queued, processing, completed, failed')
    .option('-c, --capability <capability>', 'Filter by capability, e.g. image_generation')
    .option('-l, --limit <n>', 'Max runs to return', '25')
    .action(async (opts: { status?: string; capability?: string; limit: string }) => {
      const client = await createClient();
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError('--limit must be an integer 1-100', 'invalid_limit');
      }
      const validStatuses = new Set(['queued', 'processing', 'completed', 'failed']);
      if (opts.status && !validStatuses.has(opts.status)) {
        throw new CliError(`Invalid --status: ${opts.status}`, 'invalid_status');
      }

      const response = await client.listRuns({
        status: opts.status as ('queued' | 'processing' | 'completed' | 'failed') | undefined,
        capability: opts.capability,
        limit
      });

      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No runs match.')}\n`);
          return;
        }
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
}
