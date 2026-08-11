import { Command } from 'commander';
import { BatchItem, GenFireApiError } from '@genfire/sdk';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, red, yellow } from '../output.js';
import { downloadOutputs, extractOutputUrls } from '../runHelpers.js';

const VALID_MODES = new Set(['workflow', 'operation']);
const VALID_OPERATION_TARGETS = new Set([
  'images.generations.create',
  'videos.generations.create'
]);

function statusColor(status: string): string {
  if (status === 'completed') return green(status);
  if (status === 'failed') return red(status);
  if (status === 'partial') return yellow(status);
  if (status === 'queued' || status === 'processing') return yellow(status);
  return status;
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

/**
 * Loads the batch items array from a JSON file or literal JSON string.
 * Accepts either the canonical shape `[{ "input": {...} }, ...]` or a bare
 * array of input objects `[{...}, ...]` (auto-wrapped), so users don't have
 * to hand-write the `input` envelope for every row.
 */
async function loadItems(value: string): Promise<Array<{ input: Record<string, unknown> }>> {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CliError('--items is required (path to a JSON file or a JSON array).', 'invalid_items');
  }

  let raw: string;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    raw = trimmed;
  } else {
    try {
      raw = await readFile(trimmed, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new CliError(`--items file not found: ${trimmed}`, 'items_file_not_found');
      }
      throw err;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`--items is not valid JSON: ${(err as Error).message}`, 'invalid_items');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CliError('--items must be a non-empty JSON array.', 'invalid_items');
  }
  if (parsed.length > 50) {
    throw new CliError(`--items has ${parsed.length} entries; the maximum is 50 per batch.`, 'invalid_items');
  }

  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CliError(`--items[${i}] must be a JSON object.`, 'invalid_items');
    }
    const obj = entry as Record<string, unknown>;
    // Canonical shape already has an `input` envelope; otherwise treat the
    // object itself as the input and wrap it.
    if (
      'input' in obj &&
      obj.input &&
      typeof obj.input === 'object' &&
      !Array.isArray(obj.input)
    ) {
      return { input: obj.input as Record<string, unknown> };
    }
    return { input: obj };
  });
}

export function registerBatchCommands(program: Command): void {
  const batch = program.command('batch').description('Create and inspect batches (up to 50 generations or workflow runs in one job)');

  // ---- create ----
  batch
    .command('create')
    .description('Submit a batch of operation or workflow executions')
    .requiredOption('--mode <mode>', 'Batch mode: operation | workflow')
    .requiredOption(
      '--target <target>',
      'Operation (images.generations.create | videos.generations.create) or a workflow key'
    )
    .requiredOption(
      '--items <pathOrJson>',
      'Path to a JSON file OR a literal JSON array. Each entry is { "input": {...} } or a bare input object (auto-wrapped).'
    )
    .option('-c, --concurrency <n>', 'Items processed in parallel (1-5)', '2')
    .option('-o, --output <path>', 'Directory to save completed item outputs (one subfolder per item)')
    .option('--no-download', "Don't download outputs locally; only print the batch result")
    .option('--no-wait', "Don't wait for the batch; print the queued batch and exit")
    .option('--wait-timeout <duration>', 'Maximum time to wait, e.g. 30m, 1800s', '30m')
    .option('--wait-interval <duration>', 'Polling interval while waiting', '5s')
    .action(async (opts: {
      mode: string; target: string; items: string; concurrency: string;
      output?: string; download: boolean;
      wait: boolean; waitTimeout: string; waitInterval: string;
    }) => {
      const client = await createClient();

      if (!VALID_MODES.has(opts.mode)) {
        throw new CliError('--mode must be one of: operation, workflow', 'invalid_mode');
      }
      if (opts.mode === 'operation' && !VALID_OPERATION_TARGETS.has(opts.target)) {
        throw new CliError(
          `--target for mode=operation must be one of: ${[...VALID_OPERATION_TARGETS].join(', ')}`,
          'invalid_target'
        );
      }
      const concurrency = Number(opts.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
        throw new CliError('--concurrency must be an integer 1-5', 'invalid_concurrency');
      }

      const items = await loadItems(opts.items);

      const created = await client.createBatch(
        {
          mode: opts.mode as 'operation' | 'workflow',
          target: opts.target,
          concurrency,
          items
        },
        { idempotencyKey: randomUUID() }
      );

      if (!opts.wait) {
        printResult(created, () => {
          process.stderr.write(
            `${dim('Batch queued:')} ${created.id} ${dim(`(${created.status}, ${created.total_items} items)`)}\n`
          );
          process.stderr.write(`${dim('Re-check with:')} genfire batch get ${created.id}\n`);
        });
        return;
      }

      const intervalMs = parseDurationMs(opts.waitInterval, '--wait-interval');
      const timeoutMs = parseDurationMs(opts.waitTimeout, '--wait-timeout');

      process.stderr.write(`${dim(`Polling batch ${created.id} (${created.total_items} items)...`)}\n`);
      const finished = await client.waitForBatch(created.id, {
        intervalMs,
        timeoutMs,
        onTick: (current, elapsed) => {
          if (
            current.status !== 'completed' &&
            current.status !== 'failed' &&
            current.status !== 'partial'
          ) {
            process.stderr.write(
              `${dim(
                `  status=${current.status} done=${current.completed_items}/${current.total_items}` +
                  ` failed=${current.failed_items} elapsed=${Math.round(elapsed / 1000)}s\r`
              )}`
            );
          }
        }
      });
      process.stderr.write('\n');

      const itemsResponse = await client.listBatchItems(finished.id);
      const written: string[] = [];

      if (opts.download && finished.completed_items > 0) {
        for (const item of itemsResponse.data) {
          if (item.status !== 'completed' || !item.output) continue;
          const outputs = extractOutputUrls(
            { output: item.output } as any,
            `${opts.target.replace(/[./]/g, '-')}-${item.index}`
          );
          if (outputs.length === 0) continue;
          const dest = opts.output ? join(opts.output, `item-${item.index}`) : undefined;
          const paths = await downloadOutputs(outputs, dest);
          written.push(...paths);
        }
      }

      printResult({ batch: finished, items: itemsResponse.data, downloaded_to: written }, () => {
        const tone =
          finished.status === 'completed'
            ? green
            : finished.status === 'failed'
              ? red
              : yellow;
        process.stderr.write(
          `${tone(`Batch ${finished.status}.`)} ${dim(
            `(${finished.id}) ${finished.completed_items}/${finished.total_items} completed, ${finished.failed_items} failed\n`
          )}`
        );
        for (const path of written) {
          process.stderr.write(`${dim('Saved:')} ${path}\n`);
        }
        const failures = itemsResponse.data.filter((it) => it.status === 'failed');
        for (const failure of failures) {
          const detail = failure.error?.message ? `: ${failure.error.message}` : '';
          process.stderr.write(
            `${red(`Item ${failure.index} failed`)}${dim(detail)}\n`
          );
        }
        if (finished.status === 'failed') {
          throw new CliError(
            `All ${finished.total_items} batch items failed.`,
            finished.error?.code || 'batch_failed'
          );
        }
      });
    });

  // ---- list ----
  batch
    .command('list')
    .description('List recent batches')
    .option('-s, --status <status>', 'Filter by status: queued, processing, completed, partial, failed')
    .option('-m, --mode <mode>', 'Filter by mode: operation, workflow')
    .option('-l, --limit <n>', 'Max batches to return', '25')
    .action(async (opts: { status?: string; mode?: string; limit: string }) => {
      const client = await createClient();
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError('--limit must be an integer 1-100', 'invalid_limit');
      }
      const validStatuses = new Set(['queued', 'processing', 'completed', 'partial', 'failed']);
      if (opts.status && !validStatuses.has(opts.status)) {
        throw new CliError(`Invalid --status: ${opts.status}`, 'invalid_status');
      }
      if (opts.mode && !VALID_MODES.has(opts.mode)) {
        throw new CliError(`Invalid --mode: ${opts.mode}`, 'invalid_mode');
      }

      const response = await client.listBatches({
        status: opts.status as ('queued' | 'processing' | 'completed' | 'partial' | 'failed') | undefined,
        mode: opts.mode as ('operation' | 'workflow') | undefined,
        limit
      });

      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No batches match.')}\n`);
          return;
        }
        printTable(
          response.data.map((b) => ({
            id: b.id,
            status: statusColor(b.status),
            mode: b.mode,
            target: b.target,
            items: `${b.completed_items}/${b.total_items}`,
            failed: b.failed_items,
            created: b.created_at.replace('T', ' ').slice(0, 19)
          })),
          ['id', 'status', 'mode', 'target', 'items', 'failed', 'created']
        );
      });
    });

  // ---- get ----
  batch
    .command('get <batchId>')
    .description('Show full details for a single batch')
    .action(async (batchId: string) => {
      const client = await createClient();
      try {
        const b = await client.getBatch(batchId);
        printResult(b, () => {
          process.stdout.write(`${bold(b.id)} ${dim(`(${statusColor(b.status)})`)}\n`);
          process.stdout.write(`${dim('Mode:')}       ${b.mode}\n`);
          process.stdout.write(`${dim('Target:')}     ${b.target}\n`);
          process.stdout.write(
            `${dim('Items:')}      ${cyan(`${b.completed_items}/${b.total_items}`)} completed, ` +
              `${b.failed_items} failed (concurrency ${b.concurrency})\n`
          );
          process.stdout.write(`${dim('Created:')}    ${b.created_at}\n`);
          if (b.completed_at) process.stdout.write(`${dim('Completed:')}  ${b.completed_at}\n`);
          if (b.error) {
            process.stdout.write(`${red('Error:')}      ${b.error.code}: ${b.error.message}\n`);
          }
          process.stdout.write(
            `\n${dim(`Inspect items with: genfire batch items ${b.id}`)}\n`
          );
        });
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Batch not found: ${batchId}`, 'batch_not_found');
        }
        throw err;
      }
    });

  // ---- items ----
  batch
    .command('items <batchId>')
    .description('List the items in a batch with per-item status and run ids')
    .option('-o, --output <path>', 'Directory to download every completed item output into (one subfolder per item)')
    .action(async (batchId: string, opts: { output?: string }) => {
      const client = await createClient();
      let response;
      try {
        response = await client.listBatchItems(batchId);
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Batch not found: ${batchId}`, 'batch_not_found');
        }
        throw err;
      }

      const written: string[] = [];
      if (opts.output) {
        for (const item of response.data) {
          if (item.status !== 'completed' || !item.output) continue;
          const outputs = extractOutputUrls(
            { output: item.output } as any,
            `${item.target.replace(/[./]/g, '-')}-${item.index}`
          );
          if (outputs.length === 0) continue;
          const paths = await downloadOutputs(outputs, join(opts.output, `item-${item.index}`));
          written.push(...paths);
        }
      }

      printResult({ items: response.data, downloaded_to: written }, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('This batch has no items.')}\n`);
          return;
        }
        printTable(
          response.data.map((item: BatchItem) => ({
            index: item.index,
            status: statusColor(item.status),
            run_id: item.run_id || '',
            error: item.error?.message ? item.error.message.slice(0, 60) : ''
          })),
          ['index', 'status', 'run_id', 'error']
        );
        for (const path of written) {
          process.stderr.write(`${dim('Saved:')} ${path}\n`);
        }
      });
    });
}
