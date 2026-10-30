/**
 * WS5: run cancel/delete and pro exports.
 *
 *   genfire runs cancel <runId>
 *   genfire runs delete <runId> --yes
 *   genfire timeline export <timelineId> [--formats fcpxml,xmeml,otio,edl] [--no-media]
 *   genfire export <format> (--run <id> | --url <url> | --layer-project <id>) [--fps n]
 *
 * Attached to the existing `runs` / `timeline` groups from here (registered
 * after them in index.ts) so their files stay untouched. Uses
 * publicApiRequest: the published SDK lags the API by a release.
 */
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { createClient, publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, dim, green, printResult, red, yellow } from '../output.js';
import { downloadOutputs, waitForRun } from '../runHelpers.js';

export const PRO_EXPORT_FORMATS = ['prores_422_hq', 'dnxhr_hq', 'wav', 'png_sequence', 'tiff_sequence', 'psd'] as const;
export const INTERCHANGE_FORMATS = ['fcpxml', 'xmeml', 'otio', 'edl'] as const;

const FORMAT_ALIASES: Record<string, string> = {
  prores: 'prores_422_hq', 'prores-422-hq': 'prores_422_hq', dnxhr: 'dnxhr_hq', dnx: 'dnxhr_hq',
  png: 'png_sequence', tiff: 'tiff_sequence', tif: 'tiff_sequence', photoshop: 'psd',
  premiere: 'xmeml', xml: 'xmeml', fcp: 'fcpxml', fcpx: 'fcpxml', opentimelineio: 'otio', cmx: 'edl',
};

/** Canonical pro export format, or null (exported for tests). */
export function normalizeExportFormat(raw: string): string | null {
  const value = String(raw || '').trim().toLowerCase().replace(/[\s]+/g, '_');
  const mapped = FORMAT_ALIASES[value] || value.replace(/-/g, '_');
  return (PRO_EXPORT_FORMATS as readonly string[]).includes(mapped) ? mapped : null;
}

/** `--formats a,b` → canonical interchange formats; unknown names dropped (exported for tests). */
export function parseInterchangeFormats(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((v) => v.trim().toLowerCase()).map((v) => FORMAT_ALIASES[v] || v)
    .filter((v) => (INTERCHANGE_FORMATS as readonly string[]).includes(v)))];
}

interface RunLike {
  id: string;
  status: string;
  error?: { code: string; message: string } | null;
  output?: Record<string, any> | null;
  cancellation?: { provider_cancelled: boolean; credits_refunded: number | null } | null;
}

function statusColor(status: string): string {
  if (status === 'completed') return green(status);
  if (status === 'failed') return red(status);
  return yellow(status);
}

async function finishExport(run: RunLike, opts: { wait: boolean; output?: string; download: boolean; waitTimeout: string }): Promise<void> {
  if (!opts.wait) {
    printResult(run, () => {
      process.stderr.write(`${dim('Export queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
      process.stderr.write(`${dim('Re-check with:')} genfire runs get ${run.id}\n`);
    });
    return;
  }
  const minutes = Number(opts.waitTimeout);
  const client = await createClient();
  process.stderr.write(`${dim(`Waiting for export ${run.id}...`)}\n`);
  const finished = await waitForRun(client, run.id, {
    timeoutMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000,
  }) as unknown as RunLike;
  const output = (finished.output || {}) as Record<string, any>;
  let written: string[] = [];
  if (finished.status === 'completed' && opts.download && typeof output.url === 'string') {
    written = await downloadOutputs([{ url: output.url, suggestedName: String(output.filename || `${finished.id}.bin`) }], opts.output);
  }
  printResult({ ...finished, ...(written.length ? { downloaded_to: written } : {}) }, () => {
    process.stdout.write(`${bold(finished.id)} ${statusColor(finished.status)}\n`);
    if (finished.error) process.stdout.write(`  ${red(`${finished.error.code}: ${finished.error.message}`)}\n`);
    if (typeof output.url === 'string') process.stdout.write(`  ${output.url}\n`);
    for (const path of written) process.stderr.write(`${dim('Saved:')} ${path}\n`);
    if (output.note) process.stderr.write(`${yellow(String(output.note))}\n`);
  });
  if (finished.status !== 'completed') process.exitCode = 1;
}

function addWaitOptions(command: Command): Command {
  return command
    .option('-o, --output <path>', 'Where to save the file (default: current directory)')
    .option('--no-download', "Don't download the result; only print the run")
    .option('--no-wait', 'Return the queued run immediately instead of waiting')
    .option('--wait-timeout <minutes>', 'Maximum minutes to wait', '30');
}

export function registerRunLifecycleCommands(program: Command): void {
  const runs = program.commands.find((command) => command.name() === 'runs')
    ?? program.command('runs').description('Inspect previous runs');

  runs
    .command('cancel <runId>')
    .description('Cancel a queued or processing run. Reserved credits are refunded.')
    .action(async (runId: string) => {
      const run = await publicApiRequest<RunLike>('POST', `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
      printResult(run, () => {
        process.stdout.write(`${bold(run.id)} ${statusColor(run.status)}${run.error?.code === 'cancelled' ? dim(' (cancelled)') : ''}\n`);
        const refunded = run.cancellation?.credits_refunded;
        if (refunded) process.stdout.write(`${dim('Refunded:')} ${refunded} credits\n`);
      });
    });

  runs
    .command('delete <runId>')
    .description('Permanently delete a run and its output files (inputs you supplied are kept)')
    .option('-y, --yes', 'Confirm the deletion (required)')
    .action(async (runId: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        throw new CliError(`This permanently deletes ${runId} and its outputs. Re-run with --yes to confirm.`, 'confirmation_required');
      }
      const result = await publicApiRequest<Record<string, unknown>>('DELETE', `/runs/${encodeURIComponent(runId)}`);
      printResult(result, () => {
        process.stdout.write(`${dim('Deleted')} ${bold(runId)} ${dim(`(${result.outputs_deleted ?? 0} files)`)}\n`);
      });
    });

  const timeline = program.commands.find((command) => command.name() === 'timeline')
    ?? program.command('timeline').description('Timelines');

  addWaitOptions(timeline
    .command('export <timelineId>')
    .description('Export a timeline for Final Cut Pro / Premiere / Resolve / Avid: a .zip of FCPXML, Premiere XML, OTIO and EDLs with the media bundled. Free.')
    .option('--formats <list>', `Comma-separated: ${INTERCHANGE_FORMATS.join(', ')} (default: all)`)
    .option('--no-media', 'Link media by URL instead of bundling it'))
    .action(async (timelineId: string, opts: { formats?: string; media: boolean; output?: string; download: boolean; wait: boolean; waitTimeout: string }) => {
      const formats = parseInterchangeFormats(opts.formats);
      const run = await publicApiRequest<RunLike>('POST', `/videos/timelines/${encodeURIComponent(timelineId)}/exports`, {
        body: { ...(formats.length ? { formats } : {}), include_media: opts.media },
        idempotencyKey: randomUUID(),
      });
      await finishExport(run, opts);
    });

  addWaitOptions(program
    .command('export <format>')
    .description(`Create a pro deliverable (${PRO_EXPORT_FORMATS.join(', ')}) from a run, a URL or a Layers project. Free.`)
    .option('--run <runId>', 'A finished run whose media to export')
    .option('--url <url>', 'Or an https media URL')
    .option('--layer-project <id>', 'psd: the Layers project to export')
    .option('--fps <n>', 'Image sequences: resample to this frame rate'))
    .action(async (rawFormat: string, opts: { run?: string; url?: string; layerProject?: string; fps?: string; output?: string; download: boolean; wait: boolean; waitTimeout: string }) => {
      const format = normalizeExportFormat(rawFormat);
      if (!format) throw new CliError(`Unknown export format "${rawFormat}". Use one of: ${PRO_EXPORT_FORMATS.join(', ')}.`, 'invalid_export_format');
      if (format === 'psd' && !opts.layerProject) throw new CliError('psd needs --layer-project <id>.', 'layer_project_required');
      if (format !== 'psd' && !opts.run && !opts.url) throw new CliError(`${format} needs --run <runId> or --url <url>.`, 'export_source_required');
      const fps = opts.fps === undefined ? undefined : Number(opts.fps);
      const run = await publicApiRequest<RunLike>('POST', '/exports', {
        body: {
          format,
          ...(opts.run ? { run_id: opts.run } : {}),
          ...(opts.url ? { source_url: opts.url } : {}),
          ...(opts.layerProject ? { layer_project_id: opts.layerProject } : {}),
          ...(fps && Number.isFinite(fps) ? { fps } : {}),
        },
        idempotencyKey: randomUUID(),
      });
      await finishExport(run, opts);
    });
}
