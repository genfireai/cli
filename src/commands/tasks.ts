import { Command } from 'commander';
import { publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, dim, green, printResult, printTable } from '../output.js';

/**
 * Scheduled tasks over `/v1/tasks` — standing briefs the Genfire agent runs on
 * a cadence (daily report, weekly content drop). Twins of the MCP
 * genfire_*_scheduled_task tools.
 *
 * `update` only reaches what the API lets you change after creation — active
 * and delivery. The brief, cadence and schedule are fixed; recreate the task to
 * change them.
 */

interface ScheduledTask {
  id: string;
  object: 'scheduled_task';
  title?: string | null;
  prompt: string;
  cadence: string;
  active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  max_credits_per_run: number | null;
  auto_approve: boolean;
  persona_id: string | null;
  delivery: { email: boolean; slack: boolean };
  paused_by_failure: boolean;
  last_error: string | null;
  runs_at?: string;
}

/** One run from `/v1/tasks/{id}/runs` (a schedule tick, a test run, an event fire). */
interface TaskRun {
  id: string;
  trigger: string;
  test: boolean;
  status: 'queued' | 'running' | 'ok' | 'degraded' | 'failed' | 'needs_approval';
  credits: { total: number; generations: number; tokens: number } | null;
  outputs: Array<{ run_id: string }>;
  error: string | null;
  duration_ms: number | null;
  approval: { summary: string; suggested_max_credits: number } | null;
}

const CADENCES = ['once', 'daily', 'weekly', 'monthly'];

export function registerTasksCommand(program: Command): void {
  const tasks = program
    .command('tasks')
    .description('Scheduled tasks: standing briefs the Genfire agent runs on a cadence');

  tasks
    .command('list')
    .description('List your scheduled tasks')
    .action(async () => {
      const response = await publicApiRequest<{ object: 'list'; data: ScheduledTask[] }>('GET', '/tasks');
      printResult(response, () => {
        if (!response.data?.length) {
          process.stdout.write(`${dim('No scheduled tasks. Create one: genfire tasks create "Summarise my ad spend" --cadence daily --time 09:00 --timezone Europe/London')}\n`);
          return;
        }
        printTable(
          response.data.map((t) => ({
            id: t.id,
            title: (t.title || t.prompt || '').replace(/\s+/g, ' ').slice(0, 40),
            cadence: t.cadence,
            active: t.paused_by_failure ? 'paused (failure)' : t.active ? 'yes' : 'no',
            next: t.next_run_at ? t.next_run_at.replace('T', ' ').slice(0, 16) : ''
          })),
          ['id', 'title', 'cadence', 'active', 'next']
        );
      });
    });

  tasks
    .command('create <prompt>')
    .description('Create a scheduled task. The prompt must be self-contained — a scheduled run has no conversation to read')
    .option('--title <title>', 'Short name for the task')
    .option('--cadence <cadence>', `${CADENCES.join(' | ')}`, 'daily')
    .option('--time <HH:mm>', 'Local wall-clock time of the first run (with --timezone)')
    .option('--timezone <tz>', 'IANA timezone for --time, e.g. America/New_York')
    .option('--first-run-at <iso>', 'Exact first-run instant (ISO 8601) instead of --time/--timezone')
    .option('--max-credits <n>', 'Credit ceiling per run')
    .option('--auto-approve', 'Autopilot: publish within budget without waiting for your sign-off')
    .option('--persona <id>', 'Persona id the run speaks as')
    .option('--email', 'Deliver results by email')
    .option('--slack', 'Deliver results to Slack')
    .action(async (prompt: string, opts: {
      title?: string; cadence: string; time?: string; timezone?: string; firstRunAt?: string;
      maxCredits?: string; autoApprove?: boolean; persona?: string; email?: boolean; slack?: boolean;
    }) => {
      if (!CADENCES.includes(opts.cadence)) {
        throw new CliError(`--cadence must be one of: ${CADENCES.join(', ')}`, 'invalid_cadence');
      }
      if (opts.firstRunAt && (opts.time || opts.timezone)) {
        throw new CliError('Pass either --first-run-at or --time/--timezone, not both.', 'invalid_arguments');
      }
      const maxCredits = opts.maxCredits === undefined ? undefined : Number(opts.maxCredits);
      if (maxCredits !== undefined && (!Number.isFinite(maxCredits) || maxCredits <= 0)) {
        throw new CliError('--max-credits must be a positive number', 'invalid_max_credits');
      }
      const task = await publicApiRequest<ScheduledTask>('POST', '/tasks', {
        body: {
          prompt,
          cadence: opts.cadence,
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.time ? { time: opts.time } : {}),
          ...(opts.timezone ? { timezone: opts.timezone } : {}),
          ...(opts.firstRunAt ? { first_run_at: opts.firstRunAt } : {}),
          ...(maxCredits !== undefined ? { max_credits_per_run: maxCredits } : {}),
          ...(opts.autoApprove ? { auto_approve: true } : {}),
          ...(opts.persona ? { persona_id: opts.persona } : {}),
          ...(opts.email || opts.slack ? { delivery: { email: Boolean(opts.email), slack: Boolean(opts.slack) } } : {})
        }
      });
      printResult(task, () => {
        process.stdout.write(`${green('✓')} Scheduled ${bold(task.title || task.id)} ${dim(`(${task.cadence})`)}\n`);
        process.stdout.write(`${dim('ID:')}       ${task.id}\n`);
        if (task.runs_at) process.stdout.write(`${dim('Runs at:')}  ${task.runs_at}\n`);
        if (task.next_run_at) process.stdout.write(`${dim('Next run:')} ${task.next_run_at}\n`);
      });
    });

  tasks
    .command('update <taskId>')
    .description('Pause, resume or re-route a task (brief, cadence and schedule are not editable)')
    .option('--pause', 'Stop the task from running')
    .option('--resume', 'Resume a paused task')
    .option('--email <on|off>', 'Turn email delivery on or off')
    .option('--slack <on|off>', 'Turn Slack delivery on or off')
    .action(async (taskId: string, opts: { pause?: boolean; resume?: boolean; email?: string; slack?: string }) => {
      if (opts.pause && opts.resume) {
        throw new CliError('--pause and --resume cannot be used together.', 'invalid_arguments');
      }
      const toggle = (value: string | undefined, flag: string): boolean | undefined => {
        if (value === undefined) return undefined;
        if (value === 'on') return true;
        if (value === 'off') return false;
        throw new CliError(`${flag} must be on or off`, 'invalid_option');
      };
      const email = toggle(opts.email, '--email');
      const slack = toggle(opts.slack, '--slack');
      const body: Record<string, unknown> = {};
      if (opts.pause) body.active = false;
      if (opts.resume) body.active = true;
      // The API merges a partial delivery onto what is stored, so naming one
      // channel leaves the other alone.
      if (email !== undefined || slack !== undefined) {
        body.delivery = {
          ...(email !== undefined ? { email } : {}),
          ...(slack !== undefined ? { slack } : {})
        };
      }
      if (Object.keys(body).length === 0) {
        throw new CliError('Nothing to update — pass --pause, --resume, --email or --slack.', 'nothing_to_update');
      }
      const task = await publicApiRequest<ScheduledTask>('PATCH', `/tasks/${encodeURIComponent(taskId)}`, { body });
      printResult(task, () => {
        process.stdout.write(
          `${green('✓')} Updated ${task.id} ${dim(`(active=${task.active}, email=${task.delivery.email}, slack=${task.delivery.slack})`)}\n`
        );
      });
    });

  tasks
    .command('run <taskId>')
    .description('Run a task now. A test run by default: no schedule move, no failure streak, no report sent')
    .option('--real', 'A real off-schedule fire (counts like a scheduled run)')
    .option('--deliver', 'Send the email/Slack report')
    .action(async (taskId: string, opts: { real?: boolean; deliver?: boolean }) => {
      const run = await publicApiRequest<TaskRun>('POST', `/tasks/${encodeURIComponent(taskId)}/run`, {
        body: { test: !opts.real, ...(opts.deliver ? { deliver: true } : {}) }
      });
      printResult(run, () => {
        process.stdout.write(`${green('✓')} Started ${run.id} ${dim(`(${opts.real ? 'real' : 'test'} run)`)}\n`);
        process.stdout.write(dim(`Follow it: genfire tasks runs ${taskId}\n`));
      });
    });

  tasks
    .command('runs <taskId>')
    .description('Run history: status, credits, outputs, errors and duration of each run')
    .option('--limit <n>', 'How many (1–50)', '20')
    .action(async (taskId: string, opts: { limit: string }) => {
      const response = await publicApiRequest<{ object: 'list'; data: TaskRun[] }>(
        'GET', `/tasks/${encodeURIComponent(taskId)}/runs?limit=${encodeURIComponent(opts.limit)}`
      );
      printResult(response, () => {
        if (!response.data?.length) {
          process.stdout.write(`${dim(`No runs yet. Try one: genfire tasks run ${taskId}`)}\n`);
          return;
        }
        printTable(
          response.data.map((r) => ({
            id: r.id,
            trigger: r.test ? `${r.trigger} (test)` : r.trigger,
            status: r.status,
            credits: r.credits?.total ?? 0,
            outputs: r.outputs?.length ?? 0,
            seconds: r.duration_ms == null ? '' : Math.round(r.duration_ms / 1000),
            note: (r.approval?.summary || r.error || '').replace(/\s+/g, ' ').slice(0, 50)
          })),
          ['id', 'trigger', 'status', 'credits', 'outputs', 'seconds', 'note']
        );
      });
    });

  tasks
    .command('approve <taskId> <runId>')
    .description('Continue a run that stopped with needs_approval (it may spend up to --max-credits)')
    .option('--max-credits <n>', 'Ceiling for the continuation (default: the suggested amount)')
    .action(async (taskId: string, runId: string, opts: { maxCredits?: string }) => {
      const maxCredits = opts.maxCredits === undefined ? undefined : Number(opts.maxCredits);
      if (maxCredits !== undefined && (!Number.isFinite(maxCredits) || maxCredits <= 0)) {
        throw new CliError('--max-credits must be a positive number', 'invalid_max_credits');
      }
      const run = await publicApiRequest<TaskRun>(
        'POST', `/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/approve`,
        { body: maxCredits !== undefined ? { max_credits: maxCredits } : {} }
      );
      printResult(run, () => {
        process.stdout.write(`${green('✓')} Approved — continuing as ${run.id}\n`);
      });
    });

  tasks
    .command('budget <taskId> <maxCredits>')
    .description('Set the per-run credit ceiling (a run that would go over stops for approval)')
    .action(async (taskId: string, raw: string) => {
      const maxCredits = Number(raw);
      if (!Number.isFinite(maxCredits) || maxCredits <= 0) {
        throw new CliError('maxCredits must be a positive number', 'invalid_max_credits');
      }
      const task = await publicApiRequest<ScheduledTask>('PATCH', `/tasks/${encodeURIComponent(taskId)}`, {
        body: { max_credits_per_run: maxCredits }
      });
      printResult(task, () => {
        process.stdout.write(`${green('✓')} ${task.id} ${dim(`max ${task.max_credits_per_run} credits per run`)}\n`);
      });
    });

  tasks
    .command('delete <taskId>')
    .description('Delete a scheduled task permanently')
    .action(async (taskId: string) => {
      const result = await publicApiRequest<{ id: string; deleted: boolean }>('DELETE', `/tasks/${encodeURIComponent(taskId)}`);
      printResult(result, () => {
        process.stdout.write(`${green('✓')} Deleted task ${taskId}\n`);
      });
    });
}
