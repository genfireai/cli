import { Command } from 'commander';
import { createClient, publicApiRequest } from '../client.js';
import { cyan, dim, printResult } from '../output.js';

interface TeamCredits {
  team_id: string;
  team_name?: string | null;
  balance: number;
  currency: string;
  my_usage_this_month?: number;
  my_cap?: number | null;
  my_remaining?: number | null;
  role?: string;
}

export function registerCreditsCommand(program: Command): void {
  program
    .command('credits')
    .description('Show the current credit balance — yours, or a workspace pool\'s with --team')
    .option('--team <teamId>', 'Show a workspace (team) credit pool instead, plus your own monthly cap on it (ids: genfire workspaces list)')
    .action(async (opts: { team?: string }) => {
      if (opts.team) {
        // GET /v1/account/credits?team_id= — not on the pinned SDK's getCredits.
        const pool = await publicApiRequest<TeamCredits>('GET', `/account/credits?team_id=${encodeURIComponent(opts.team)}`);
        printResult(pool, () => {
          process.stdout.write(`${cyan(String(pool.balance))} ${dim(pool.currency)} ${dim(`in ${pool.team_name || pool.team_id}`)}\n`);
          if (pool.my_cap != null) {
            process.stdout.write(
              `${dim('Your cap:')} ${pool.my_usage_this_month ?? 0}/${pool.my_cap} this month ${dim(`(${pool.my_remaining ?? 0} left)`)}\n`
            );
          }
        });
        return;
      }
      const client = await createClient();
      const credits = await client.getCredits();
      printResult(credits, () => {
        process.stdout.write(`${cyan(String(credits.balance))} ${dim(credits.currency)}\n`);
      });
    });
}
