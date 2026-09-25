import { Command } from 'commander';
import { GenFireApiError } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { resolveMediaInput } from '../runHelpers.js';
import { bold, cyan, dim, green, printResult, printTable, yellow } from '../output.js';

// Shared success output for both create modes (photos / from-scratch). Note
// creation is async: status is usually `creating` — poll `influencers get`.
function printCreated(influencer: {
  id: string;
  handle: string;
  display_name: string;
  status: string;
  preview_url?: string | null;
}): void {
  printResult(influencer, () => {
    process.stdout.write(`${green('✓')} Created ${bold('@' + influencer.handle)}  ${influencer.display_name}\n`);
    process.stdout.write(`${dim('ID:')}     ${influencer.id}\n`);
    process.stdout.write(`${dim('Status:')} ${influencer.status === 'ready' ? green(influencer.status) : yellow(influencer.status)}\n`);
    if (influencer.preview_url) {
      process.stdout.write(`${dim('Preview:')} ${cyan(influencer.preview_url)}\n`);
    }
    if (influencer.status !== 'ready') {
      process.stdout.write(`${dim(`Generating… poll with: genfire influencers get ${influencer.id}`)}\n`);
    }
    process.stdout.write(`\n${dim(`Use in prompts: genfire generate image "@${influencer.handle} at a coffee shop"`)}\n`);
  });
}

export function registerInfluencersCommand(program: Command): void {
  const influencers = program.command('influencers').description('Create and inspect your influencer characters');

  influencers
    .command('create <handle>')
    .description('Create a reusable influencer — from reference photos, or from scratch with --gender/--heritage/--age')
    .option('-p, --photo <urlOrPath...>', 'FROM PHOTOS: reference photo URL or local path (auto-uploaded). Repeat or pass multiple; 1–8 total. Mutually exclusive with the appearance flags.')
    .option('--gender <gender>', 'FROM SCRATCH: gender, e.g. "woman", "man".')
    .option('--heritage <heritage>', 'FROM SCRATCH: race/ethnicity, e.g. "korean".')
    .option('--age <range>', 'FROM SCRATCH: age range — one of 18-21, 21-25, 25-30, 30-40, 40+.')
    .option('--appearance <text>', 'FROM SCRATCH: optional free-text appearance descriptor, e.g. "freckles, platinum bob, green eyes".')
    .action(async (handle: string, opts: { photo?: string[]; gender?: string; heritage?: string; age?: string; appearance?: string }) => {
      const photos = opts.photo || [];
      const wantsScratch = Boolean(opts.gender || opts.heritage || opts.age || opts.appearance);

      if (photos.length > 0 && wantsScratch) {
        throw new CliError('Provide either photos (-p) or the appearance flags (--gender/--heritage/--age), not both.', 'ambiguous_mode');
      }
      if (photos.length === 0 && !wantsScratch) {
        throw new CliError('Provide 1–8 photos with -p/--photo, or create from scratch with --gender, --heritage and --age.', 'missing_input');
      }

      const client = await createClient();

      if (wantsScratch) {
        const validAges = ['18-21', '21-25', '25-30', '30-40', '40+'];
        if (!opts.gender || !opts.heritage || !opts.age) {
          throw new CliError('From-scratch creation needs --gender, --heritage and --age.', 'missing_appearance');
        }
        if (!validAges.includes(opts.age)) {
          throw new CliError(`--age must be one of: ${validAges.join(', ')}.`, 'invalid_age');
        }
        process.stdout.write(`${dim('Generating your influencer from scratch (hero photo + reference sheet, billable, ~60–120s)…')}\n`);
        const influencer = await client.createInfluencer({
          handle,
          appearance: {
            gender: opts.gender,
            heritage: opts.heritage,
            age: opts.age as '18-21' | '21-25' | '25-30' | '30-40' | '40+',
            prompt: opts.appearance
          }
        });
        printCreated(influencer);
        return;
      }

      if (photos.length > 8) {
        throw new CliError('Provide between 1 and 8 photos with -p/--photo.', 'invalid_photo_count');
      }
      // Auto-upload any local paths; pass through https URLs unchanged.
      const photoUrls: string[] = [];
      for (const photo of photos) {
        const resolved = await resolveMediaInput(client, photo);
        photoUrls.push(resolved.url);
      }
      process.stdout.write(`${dim('Generating your influencer from these photos (hero portrait + reference sheet, billable, ~60–120s)…')}\n`);
      const influencer = await client.createInfluencer({ handle, photoUrls });
      printCreated(influencer);
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
 * Resolve the `@<handle>` mentions in an image prompt.
 *
 * Returns the first handle that names one of the user's influencers as a
 * `{handle, influencer_id}` mention (the image route binds ONE influencer, via
 * the explicit `mentions` array). Handles that name a saved ELEMENT are left in
 * the prompt untouched — the API resolves `@element` props server-side — so
 * "@maya holding @red_bottle" binds Maya and the bottle. Returns `null` when
 * no handle names an influencer. Throws only when NO handle names either an
 * influencer or an element (almost always a typo, and cheaper to catch before
 * the run is billed).
 *
 * Before this, the FIRST handle had to be an influencer: any element mention
 * (`genfire elements` advertises exactly that usage) died with
 * `unknown_influencer_handle`.
 *
 * The handle regex mirrors the backend's accepted format
 * (`/^[a-zA-Z0-9_-]{1,32}$/`) so client-side validation matches the contract.
 */
export async function resolveMentionFromPrompt(
  prompt: string,
  client?: import('@genfire/sdk').GenFireClient
): Promise<{ handle: string; influencer_id: string } | null> {
  const handles = [...prompt.matchAll(/(?:^|[^a-zA-Z0-9_.])@([a-zA-Z0-9_-]{1,32})\b/g)].map((m) => m[1]);
  if (handles.length === 0) return null;

  const apiClient = client ?? (await createClient());
  const influencers = await apiClient.listInfluencers();
  for (const handle of handles) {
    const found = influencers.data.find((i) => i.handle.toLowerCase() === handle.toLowerCase());
    if (found) return { handle: found.handle, influencer_id: found.id };
  }

  const elements = await apiClient.listElements();
  const elementHandles = new Set(elements.data.map((e) => (e.handle || '').toLowerCase()).filter(Boolean));
  if (handles.some((h) => elementHandles.has(h.toLowerCase()))) return null;

  throw new CliError(
    `No influencer or element with handle ${handles.map((h) => '@' + h).join(', ')}. ` +
    'Run `genfire influencers list` or `genfire elements list` to see available handles.',
    'unknown_mention_handle'
  );
}
