import { Command } from 'commander';
import { publicApiRequest } from '../client.js';
import { bold, cyan, dim, printResult, printTable } from '../output.js';

/**
 * Workspaces — `/v1/teams`. A team is the API's WORKSPACE: a shared credit
 * pool and a member roster. Read-only on /v1 (teams are created and managed in
 * the dashboard); the id is what `--team <id>` on generate/batch bills.
 */

interface TeamRecord {
  id: string;
  object: 'team';
  name: string;
  role: string | null;
  is_owner: boolean;
  member_count: number;
  seat_limit: number | null;
  pool: { balance: number | null; currency: 'credits' } | null;
  created_at: string | null;
  updated_at: string | null;
  my_usage_this_month?: number;
  my_cap?: number | null;
}

export function registerWorkspacesCommand(program: Command): void {
  const workspaces = program
    .command('workspaces')
    .description('List the workspaces (teams) you belong to and their shared credit pools');

  workspaces
    .command('list')
    .description('List your workspaces — pass an id as --team on generate/batch to bill its pool')
    .action(async () => {
      const response = await publicApiRequest<{ object: 'list'; data: TeamRecord[]; note?: string }>('GET', '/teams');
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('You are not a member of any workspace.')}\n`);
          return;
        }
        printTable(
          response.data.map((t) => ({
            id: t.id,
            name: t.name,
            role: t.is_owner ? 'owner' : (t.role ?? ''),
            members: t.seat_limit != null ? `${t.member_count}/${t.seat_limit}` : t.member_count,
            pool: t.pool?.balance ?? ''
          })),
          ['id', 'name', 'role', 'members', 'pool']
        );
        process.stdout.write(`\n${dim('Bill a run to a workspace: genfire generate image "…" --team <id>')}\n`);
      });
    });

  workspaces
    .command('get <teamId>')
    .description('Show one workspace, its pool balance and your usage against your monthly cap')
    .action(async (teamId: string) => {
      const team = await publicApiRequest<TeamRecord>('GET', `/teams/${encodeURIComponent(teamId)}`);
      printResult(team, () => {
        process.stdout.write(`${bold(team.name)}  ${dim(team.id)}\n`);
        process.stdout.write(`${dim('Role:')}      ${team.is_owner ? 'owner' : (team.role ?? '')}\n`);
        process.stdout.write(
          `${dim('Members:')}   ${team.member_count}${team.seat_limit != null ? ` / ${team.seat_limit} seats` : ''}\n`
        );
        if (team.pool) {
          process.stdout.write(`${dim('Pool:')}      ${cyan(String(team.pool.balance ?? '—'))} ${dim('credits')}\n`);
        }
        if (team.my_usage_this_month !== undefined) {
          const cap = team.my_cap == null ? 'no cap' : `cap ${team.my_cap}`;
          process.stdout.write(`${dim('You:')}       ${team.my_usage_this_month} used this month ${dim(`(${cap})`)}\n`);
        }
      });
    });
}
