import { Command } from 'commander';
import { publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, red, yellow } from '../output.js';

/**
 * The Genfire agent over `/v1/agent/sessions` — give it a job, wait for the
 * turn, read the transcript. Twins of the MCP genfire_agent_* tools.
 *
 * Off for an account until Genfire enables it: every call answers 404
 * `agent_api_not_enabled` until then. A turn spends up to --max-credits on
 * generations (default 50); past that it stops with `needs_approval` —
 * `genfire agent approve` continues it.
 */

interface AgentApproval {
  id: string;
  kind: 'over_budget' | 'price_unknown' | 'publish';
  status: string;
  summary: string;
  spent_credits: number;
  max_credits: number;
  suggested_max_credits: number;
}

interface AgentTurn {
  id: string;
  status: string;
  response: string | null;
  error: { code: string; message: string } | null;
  spend: { credits: number };
  output_run_ids: string[];
}

interface AgentSession {
  id: string;
  title: string | null;
  status: 'running' | 'idle' | 'needs_approval' | 'failed' | 'cancelled';
  spend: { credits: number; turns: number };
  current_turn: AgentTurn | null;
  approval: AgentApproval | null;
  last_message: string | null;
  updated_at: string;
  messages?: Array<{ role: string; content: string }>;
  outputs?: Array<{ run_id: string; capability: string; status: string; url: string | null }>;
  timed_out?: boolean;
}

/** --max-credits as a number (the API clamps out-of-range values). */
export function parseMaxCredits(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new CliError('--max-credits must be a number ≥ 0', 'invalid_max_credits');
  return Math.round(n);
}

/** Server-side waits are capped at 300 s, so a longer --timeout loops. */
export function waitSlices(totalSeconds: number): number[] {
  const total = Math.max(1, Math.round(Number.isFinite(totalSeconds) ? totalSeconds : 60));
  const out: number[] = [];
  for (let left = total; left > 0; left -= 300) out.push(Math.min(300, left));
  return out;
}

const path = (sessionId: string, suffix = '') => `/agent/sessions/${encodeURIComponent(sessionId)}${suffix}`;

async function waitFor(sessionId: string, seconds: number): Promise<AgentSession> {
  let session: AgentSession | undefined;
  for (const slice of waitSlices(seconds)) {
    session = await publicApiRequest<AgentSession>('POST', path(sessionId, '/wait'), { body: { timeout_seconds: slice } });
    if (!session.timed_out) break;
  }
  return session!;
}

function renderSession(session: AgentSession): void {
  const status = session.status === 'idle' ? green('done')
    : session.status === 'needs_approval' ? yellow('needs approval')
    : session.status === 'running' ? cyan('running')
    : red(session.status);
  process.stdout.write(`${bold(session.title || session.id)} ${dim(session.id)}  ${status}  ${dim(`${session.spend?.credits ?? 0} credits`)}\n`);
  const turn = session.current_turn;
  if (turn?.response) process.stdout.write(`\n${turn.response}\n`);
  else if (session.last_message && session.status !== 'running') process.stdout.write(`\n${session.last_message}\n`);
  if (turn?.error) process.stdout.write(`${red('✗')} ${turn.error.message} ${dim(`(${turn.error.code})`)}\n`);
  if (session.approval?.status === 'pending') {
    const a = session.approval;
    process.stdout.write(`\n${yellow('!')} ${a.summary}\n`);
    process.stdout.write(dim(`  Continue (may spend up to ${a.suggested_max_credits} credits): genfire agent approve ${session.id}\n`));
  }
  if (session.timed_out) process.stdout.write(dim(`\nStill working — genfire agent wait ${session.id}\n`));
  if (turn?.output_run_ids?.length) process.stdout.write(dim(`\nOutputs: ${turn.output_run_ids.join(', ')}\n`));
}

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command('agent')
    .description('The Genfire agent: give it a job and read what it made (spends within --max-credits)');

  agent
    .command('send <message>')
    .description('Start a session (or, with --session, send the next message) and wait for the reply')
    .option('--session <id>', 'Continue this session (ags_…)')
    .option('--max-credits <n>', 'Generation credits this turn may spend (default 50, max 2000)')
    .option('--model <id>', 'Agent model (new sessions)')
    .option('--title <title>', 'Session title (new sessions)')
    .option('--attach <url...>', 'https image URLs to attach')
    .option('--no-wait', 'Answer as soon as the turn is queued')
    .option('--timeout <seconds>', 'How long to wait for the reply', '300')
    .action(async (message: string, opts: {
      session?: string; maxCredits?: string; model?: string; title?: string; attach?: string[]; wait: boolean; timeout: string;
    }) => {
      const maxCredits = parseMaxCredits(opts.maxCredits);
      const body: Record<string, unknown> = {
        message,
        ...(maxCredits !== undefined ? { max_credits: maxCredits } : {}),
        ...(opts.attach?.length ? { attachments: opts.attach } : {})
      };
      if (!opts.session) {
        if (opts.model) body.model = opts.model;
        if (opts.title) body.title = opts.title;
      }
      let session = await publicApiRequest<AgentSession>('POST', opts.session ? path(opts.session, '/messages') : '/agent/sessions', { body });
      if (opts.wait) session = await waitFor(session.id, Number(opts.timeout));
      printResult(session, () => renderSession(session));
    });

  agent
    .command('get <sessionId>')
    .description('A session with its transcript and outputs')
    .action(async (sessionId: string) => {
      const session = await publicApiRequest<AgentSession>('GET', path(sessionId));
      printResult(session, () => {
        for (const m of session.messages || []) {
          process.stdout.write(`${m.role === 'user' ? cyan('you') : bold('agent')}  ${m.content}\n\n`);
        }
        renderSession({ ...session, current_turn: session.current_turn ? { ...session.current_turn, response: null } : null, last_message: null });
        for (const o of session.outputs || []) process.stdout.write(`${dim(o.run_id)} ${o.capability} ${o.status} ${o.url || ''}\n`);
      });
    });

  agent
    .command('wait <sessionId>')
    .description('Wait for the current turn to finish (a timeout never cancels it)')
    .option('--timeout <seconds>', 'How long to wait', '300')
    .action(async (sessionId: string, opts: { timeout: string }) => {
      const session = await waitFor(sessionId, Number(opts.timeout));
      printResult(session, () => renderSession(session));
    });

  agent
    .command('approve <sessionId>')
    .description('Continue a turn that stopped with needs_approval (it may spend up to --max-credits)')
    .option('--max-credits <n>', 'Ceiling for the continuation (default: the suggested amount)')
    .option('--no-wait', 'Answer as soon as the continuation is queued')
    .option('--timeout <seconds>', 'How long to wait', '300')
    .action(async (sessionId: string, opts: { maxCredits?: string; wait: boolean; timeout: string }) => {
      const maxCredits = parseMaxCredits(opts.maxCredits);
      let session = await publicApiRequest<AgentSession>('POST', path(sessionId, '/approve'), {
        body: maxCredits !== undefined ? { max_credits: maxCredits } : {}
      });
      if (opts.wait) session = await waitFor(session.id, Number(opts.timeout));
      printResult(session, () => renderSession(session));
    });

  agent
    .command('cancel <sessionId>')
    .description('Stop the running turn at its next step (what already ran is kept)')
    .action(async (sessionId: string) => {
      const session = await publicApiRequest<AgentSession>('POST', path(sessionId, '/cancel'), { body: {} });
      printResult(session, () => process.stdout.write(`${green('✓')} ${session.id} ${dim(session.status)}\n`));
    });

  agent
    .command('list')
    .description('Your recent agent sessions')
    .option('--limit <n>', 'How many (1–50)', '20')
    .action(async (opts: { limit: string }) => {
      const response = await publicApiRequest<{ object: 'list'; data: AgentSession[]; next_cursor: string | null }>(
        'GET', `/agent/sessions?limit=${encodeURIComponent(opts.limit)}`
      );
      printResult(response, () => {
        if (!response.data?.length) {
          process.stdout.write(`${dim('No agent sessions yet. Start one: genfire agent send "Make three product shots of my mug"')}\n`);
          return;
        }
        printTable(
          response.data.map((s) => ({
            id: s.id,
            title: (s.title || s.last_message || '').replace(/\s+/g, ' ').slice(0, 40),
            status: s.status,
            credits: s.spend?.credits ?? 0,
            updated: s.updated_at ? s.updated_at.replace('T', ' ').slice(0, 16) : ''
          })),
          ['id', 'title', 'status', 'credits', 'updated']
        );
      });
    });
}
