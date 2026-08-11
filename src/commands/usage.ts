import { Command } from 'commander';
import type { UsageGroupBy } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, dim, green, printResult, printTable, red } from '../output.js';

const GROUP_BY = new Set<UsageGroupBy>(['model', 'capability', 'day', 'none']);

export function registerUsageCommand(program: Command): void {
  program
    .command('usage')
    .description('Credit spend and run counts over a date range (default: last 30 days)')
    .option('-s, --start <date>', 'ISO start date, e.g. 2026-07-01')
    .option('-e, --end <date>', 'ISO end date')
    .option('-g, --group-by <field>', 'model (default) | capability | day | none', 'model')
    .option('-c, --capability <name>', "Restrict to one capability, e.g. 'video_generation'")
    .action(async (opts: { start?: string; end?: string; groupBy: string; capability?: string }) => {
      if (!GROUP_BY.has(opts.groupBy as UsageGroupBy)) {
        throw new CliError(
          `Invalid --group-by: ${opts.groupBy}. Use ${[...GROUP_BY].join(', ')}.`,
          'invalid_group_by'
        );
      }
      for (const [flag, value] of [['--start', opts.start], ['--end', opts.end]] as const) {
        if (value && Number.isNaN(Date.parse(value))) {
          throw new CliError(`Invalid ${flag}: ${value}. Use an ISO date.`, 'invalid_date');
        }
      }

      const client = await createClient();
      const summary = await client.getUsage({
        start_date: opts.start,
        end_date: opts.end,
        group_by: opts.groupBy as UsageGroupBy,
        capability: opts.capability
      });

      printResult(summary, () => {
        const { totals, period } = summary;
        process.stdout.write(
          `${bold(totals.credits_spent.toLocaleString())} credits ` +
          `${dim(`over ${period.start.slice(0, 10)} → ${period.end.slice(0, 10)}`)}\n`
        );
        process.stdout.write(
          `${dim('Runs:')} ${totals.runs_count} ` +
          `${green(`${totals.successful_runs} ok`)}` +
          `${totals.failed_runs > 0 ? ` · ${red(`${totals.failed_runs} failed`)}` : ''}\n\n`
        );

        if (summary.breakdown.length === 0) {
          process.stdout.write(`${dim('(no usage in this period)')}\n`);
          return;
        }
        printTable(
          summary.breakdown.map((entry) => ({
            [summary.group_by]: entry.group,
            credits: entry.credits_spent.toLocaleString(),
            runs: entry.runs_count,
            ok: entry.successful_runs,
            failed: entry.failed_runs,
            avg: entry.avg_credits_per_run.toFixed(1)
          })),
          [summary.group_by, 'credits', 'runs', 'ok', 'failed', 'avg']
        );
      });
    });
}
