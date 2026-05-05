import { Command } from 'commander';
import { createClient } from '../client.js';
import { cyan, dim, printResult } from '../output.js';

export function registerCreditsCommand(program: Command): void {
  program
    .command('credits')
    .description('Show the current credit balance')
    .action(async () => {
      const client = await createClient();
      const credits = await client.getCredits();
      printResult(credits, () => {
        process.stdout.write(`${cyan(String(credits.balance))} ${dim(credits.currency)}\n`);
      });
    });
}
