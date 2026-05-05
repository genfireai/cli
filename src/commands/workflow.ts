import { Command } from 'commander';
import { GenFireApiError } from '@genfire/sdk';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, printResult, printTable } from '../output.js';
import {
  downloadOutputs,
  extractOutputUrls,
  reportRunCompletion,
  waitForRun
} from '../runHelpers.js';

export function registerWorkflowCommands(program: Command): void {
  const workflow = program.command('workflow').description('Run and inspect GenFire workflows (graph-based pipelines)');

  workflow
    .command('list')
    .description('List published workflows')
    .action(async () => {
      const client = await createClient();
      const response = await client.listWorkflows();
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No workflows are published.')}\n`);
          return;
        }
        printTable(
          response.data.map((wf) => ({
            id: wf.id,
            name: wf.name,
            status: wf.status
          })),
          ['id', 'name', 'status']
        );
        process.stdout.write(
          `\n${dim(`Run one with: genfire workflow run <id> --inputs vars.json`)}\n`
        );
      });
    });

  workflow
    .command('get <workflowKey>')
    .description('Show full details for a workflow including its input schema')
    .action(async (workflowKey: string) => {
      const client = await createClient();
      try {
        const wf = await client.getWorkflow(workflowKey);
        printResult(wf, () => {
          process.stdout.write(`${bold(wf.name)}  ${dim(wf.id)} ${dim(`(${wf.status})`)}\n`);
          process.stdout.write(`${wf.description}\n\n`);
          process.stdout.write(`${dim('Input schema:')}\n${JSON.stringify(wf.input_schema, null, 2)}\n`);
          if (wf.output_schema && Object.keys(wf.output_schema).length > 0) {
            process.stdout.write(`\n${dim('Output schema:')}\n${JSON.stringify(wf.output_schema, null, 2)}\n`);
          }
        });
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Workflow not found: ${workflowKey}`, 'workflow_not_found');
        }
        throw err;
      }
    });

  workflow
    .command('run <workflowKey>')
    .description('Execute a workflow with the given inputs')
    .option('-i, --inputs <pathOrJson>', 'Path to a JSON file OR a literal JSON string of inputs', '{}')
    .option('-o, --output <path>', 'Where to save downloaded outputs')
    .option('--no-download', "Don't download outputs locally")
    .option('--wait, --no-wait', 'Wait for completion (default: wait)', true)
    .option('--wait-timeout <duration>', 'Maximum time to wait, e.g. 30m', '30m')
    .option('--wait-interval <duration>', 'Polling interval', '3s')
    .action(async (workflowKey: string, opts: {
      inputs: string; output?: string; noDownload?: boolean;
      wait: boolean; waitTimeout: string; waitInterval: string;
    }) => {
      const client = await createClient();
      const inputs = await loadInputs(opts.inputs);

      const run = await client.runWorkflow(workflowKey, inputs, {
        idempotencyKey: randomUUID()
      });

      if (!opts.wait) {
        printResult(run, () => {
          process.stderr.write(`${dim('Workflow queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
          process.stderr.write(`${dim('Re-check with:')} genfire runs get ${run.id}\n`);
        });
        return;
      }

      const intervalMs = parseDurationMs(opts.waitInterval, '--wait-interval');
      const timeoutMs = parseDurationMs(opts.waitTimeout, '--wait-timeout');

      process.stderr.write(`${dim(`Polling workflow run ${run.id}...`)}\n`);
      const completed = await waitForRun(client, run.id, {
        intervalMs,
        timeoutMs,
        onTick: (current, elapsed) => {
          if (current.status !== 'completed' && current.status !== 'failed') {
            process.stderr.write(
              `${dim(`  status=${current.status} elapsed=${Math.round(elapsed / 1000)}s\r`)}`
            );
          }
        }
      });
      process.stderr.write('\n');

      if (completed.status !== 'completed' || opts.noDownload) {
        reportRunCompletion(completed, []);
        return;
      }

      const outputs = extractOutputUrls(completed, `workflow-${workflowKey}`);
      const written = await downloadOutputs(outputs, opts.output);
      reportRunCompletion(completed, written);
    });
}

async function loadInputs(value: string): Promise<Record<string, unknown>> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new CliError('--inputs JSON must be an object at the top level.', 'invalid_inputs');
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(`--inputs is not valid JSON: ${(err as Error).message}`, 'invalid_inputs');
    }
  }

  // Treat as file path
  let raw: string;
  try {
    raw = await readFile(trimmed, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new CliError(`--inputs file not found: ${trimmed}`, 'inputs_file_not_found');
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new CliError(`Top-level JSON in ${trimmed} must be an object.`, 'invalid_inputs');
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`${trimmed} is not valid JSON: ${(err as Error).message}`, 'invalid_inputs');
  }
}

function parseDurationMs(value: string, flag: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) {
    throw new CliError(`Invalid duration for ${flag}: ${value}`, 'invalid_duration');
  }
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms') return Math.max(1, Math.round(amount));
  if (unit === 'm') return Math.round(amount * 60 * 1000);
  return Math.round(amount * 1000);
}
