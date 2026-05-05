import { Command } from 'commander';
import { GenFireApiError } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, yellow } from '../output.js';

export function registerInfluencersCommand(program: Command): void {
  const influencers = program.command('influencers').description('Inspect your trained influencer characters');

  influencers
    .command('list')
    .description('List your ready influencers (drafts and archived are hidden)')
    .action(async () => {
      const client = await createClient();
      const response = await client.listInfluencers();
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No ready influencers.')}\n`);
          process.stdout.write(`${dim('Train one in the dashboard at https://genfire.ai/dashboard/influencers')}\n`);
          return;
        }
        printTable(
          response.data.map((i) => ({
            handle: '@' + (i.handle || '(unset)'),
            name: i.display_name,
            id: i.id,
            source: i.source_type,
            updated: i.updated_at.replace('T', ' ').slice(0, 19)
          })),
          ['handle', 'name', 'id', 'source', 'updated']
        );
        process.stdout.write(
          `\n${dim('Use in prompts: genfire generate image "@<handle> at a coffee shop"')}\n`
        );
      });
    });

  influencers
    .command('get <influencerId>')
    .description('Show full details for one influencer')
    .action(async (id: string) => {
      const client = await createClient();
      try {
        const i = await client.getInfluencer(id);
        printResult(i, () => {
          process.stdout.write(`${bold('@' + i.handle)}  ${i.display_name}\n`);
          process.stdout.write(`${dim('ID:')}      ${i.id}\n`);
          process.stdout.write(`${dim('Status:')}  ${i.status === 'ready' ? green(i.status) : yellow(i.status)}\n`);
          process.stdout.write(`${dim('Source:')}  ${i.source_type}\n`);
          if (i.preview_url) {
            process.stdout.write(`${dim('Preview:')} ${cyan(i.preview_url)}\n`);
          }
          process.stdout.write(`${dim('Created:')} ${i.created_at}\n`);
          process.stdout.write(`${dim('Updated:')} ${i.updated_at}\n`);
        });
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Influencer not found: ${id}`, 'influencer_not_found');
        }
        throw err;
      }
    });
}

/**
 * Resolve an `@<handle>` substring in a prompt to a `{handle, influencer_id}` mention
 * by looking up the user's influencers. Returns `null` when no `@` mention is present.
 * Throws if the handle doesn't match any ready influencer.
 *
 * The handle regex deliberately mirrors the backend's accepted format
 * (`/^[a-zA-Z0-9_-]{1,32}$/`) so client-side validation matches the contract.
 */
export async function resolveMentionFromPrompt(
  prompt: string,
  client?: import('@genfire/sdk').GenFireClient
): Promise<{ handle: string; influencer_id: string } | null> {
  const match = prompt.match(/@([a-zA-Z0-9_-]{1,32})\b/);
  if (!match) return null;
  const handle = match[1];

  const apiClient = client ?? (await createClient());
  const response = await apiClient.listInfluencers();
  const found = response.data.find((i) => i.handle.toLowerCase() === handle.toLowerCase());
  if (!found) {
    throw new CliError(
      `No ready influencer with handle @${handle}. Run \`genfire influencers list\` to see available handles.`,
      'unknown_influencer_handle'
    );
  }
  return { handle: found.handle, influencer_id: found.id };
}
