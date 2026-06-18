import { Command } from 'commander';
import { GenFireApiError } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { resolveMediaInput } from '../runHelpers.js';
import { bold, cyan, dim, green, printResult, printTable, yellow } from '../output.js';

export function registerInfluencersCommand(program: Command): void {
  const influencers = program.command('influencers').description('Create and inspect your influencer characters');

  influencers
    .command('create <handle>')
    .description('Create a reusable influencer from 1–8 reference photos (URLs or local paths)')
    .requiredOption('-p, --photo <urlOrPath...>', 'Reference photo URL or local path (auto-uploaded). Repeat or pass multiple; 1–8 total.')
    .option('-n, --name <name>', 'Display name (defaults to the handle)')
    .action(async (handle: string, opts: { photo: string[]; name?: string }) => {
      const photos = opts.photo || [];
      if (photos.length < 1 || photos.length > 8) {
        throw new CliError('Provide between 1 and 8 photos with -p/--photo.', 'invalid_photo_count');
      }
      const client = await createClient();
      // Auto-upload any local paths; pass through https URLs unchanged.
      const photoUrls: string[] = [];
      for (const photo of photos) {
        const resolved = await resolveMediaInput(client, photo);
        photoUrls.push(resolved.url);
      }
      process.stdout.write(`${dim('Generating reference sheet to lock identity (this is billable, ~30–60s)…')}\n`);
      const influencer = await client.createInfluencer({
        handle,
        displayName: opts.name,
        photoUrls
      });
      printResult(influencer, () => {
        process.stdout.write(`${green('✓')} Created ${bold('@' + influencer.handle)}  ${influencer.display_name}\n`);
        process.stdout.write(`${dim('ID:')}     ${influencer.id}\n`);
        process.stdout.write(`${dim('Status:')} ${influencer.status === 'ready' ? green(influencer.status) : yellow(influencer.status)}\n`);
        if (influencer.preview_url) {
          process.stdout.write(`${dim('Preview:')} ${cyan(influencer.preview_url)}\n`);
        }
        process.stdout.write(`\n${dim(`Use in prompts: genfire generate image "@${influencer.handle} at a coffee shop"`)}\n`);
      });
    });

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
