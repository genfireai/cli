import { Command } from 'commander';
import { createClient } from '../client.js';
import { bold, cyan, dim, printResult } from '../output.js';

export function registerAccountCommand(program: Command): void {
  program
    .command('account')
    .description('Show account identity and credit balance')
    .action(async () => {
      const client = await createClient();
      const [account, credits] = await Promise.all([
        client.getAccount(),
        client.getCredits()
      ]);

      printResult({ account, credits }, () => {
        process.stdout.write(
          `${bold(account.display_name || account.id)}  ${dim(account.email || '')}\n` +
          `${dim('Plan:')}    ${account.plan}\n` +
          `${dim('Status:')}  ${account.status}\n` +
          `${dim('Credits:')} ${cyan(String(credits.balance))} ${dim(credits.currency)}\n`
        );
      });
    });
}
