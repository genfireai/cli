import { Command } from 'commander';
import { createClient } from '../client.js';
import { dim, printResult, printTable } from '../output.js';

export function registerVoicesCommand(program: Command): void {
  const voices = program.command('voices').description('List voices you can use with `generate speech`');

  voices
    .command('list')
    .description('List your cloned voices (pass --stock to also include built-in ElevenLabs voices)')
    .option('--stock', 'Also include built-in ElevenLabs stock voices')
    .action(async (opts: { stock?: boolean }) => {
      const client = await createClient();
      const response = await client.listVoices({ includeStock: Boolean(opts.stock) });
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No cloned voices.')}\n`);
          process.stdout.write(
            `${dim('Clone one in the dashboard at https://genfire.ai/dashboard, then it appears here.')}\n`
          );
          return;
        }
        printTable(
          response.data.map((v) => ({
            id: v.id,
            name: v.name,
            type: v.type,
            provider: v.provider,
            created: v.created_at ? v.created_at.replace('T', ' ').slice(0, 19) : ''
          })),
          ['id', 'name', 'type', 'provider', 'created']
        );
        process.stdout.write(
          `\n${dim('Use one: genfire generate speech "Hello" --voice-id <id>')}\n`
        );
      });
    });
}
