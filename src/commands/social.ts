import { Command } from 'commander';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printJson, printResult, printTable, yellow } from '../output.js';
import { resolveMediaInput } from '../runHelpers.js';

export function registerSocialCommand(program: Command): void {
  const social = program
    .command('social')
    .description('Publish to connected social accounts and read public platform data');

  social
    .command('accounts')
    .description('List connected accounts and the target refs used when posting')
    .action(async () => {
      const client = await createClient();
      const response = await client.listSocialAccounts();
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${yellow('No connected accounts.')}\n`);
          process.stdout.write(`${dim('Connect one at:')} ${cyan(response.connect_url)}\n`);
          return;
        }
        printTable(
          response.data.map((a) => ({
            target: a.target,
            platform: a.platform,
            username: a.username || '—',
            publish: a.publish_enabled ? 'yes' : 'no'
          })),
          ['target', 'platform', 'username', 'publish']
        );
        process.stdout.write(`${dim('Add more at:')} ${cyan(response.connect_url)}\n`);
      });
    });

  social
    .command('post')
    .description('Publish or schedule a post. Provide exactly one source.')
    .requiredOption('-t, --target <target...>', 'Where to post, e.g. tiktok:123 (see: genfire social accounts)')
    .option('--reel-id <id>', 'Publish an existing faceless reel')
    .option('--video <urlOrPath>', 'Publish a video by URL or local path (auto-uploaded)')
    .option('--image <urlOrPath...>', 'Publish one or more images')
    .option('-c, --caption <text>', 'Caption (or the body of a LinkedIn/Facebook text post)')
    .option('--title <title>', 'YouTube video title')
    .option('--label <label>', 'Internal label for this post')
    .option('--privacy <value>', "Platform privacy value, e.g. 'public'")
    .option('--schedule <when>', 'Publish later: epoch ms or an ISO timestamp')
    .option('--timezone <zone>', 'IANA zone for --schedule', 'UTC')
    .action(async (opts: {
      target: string[]; reelId?: string; video?: string; image?: string[]; caption?: string;
      title?: string; label?: string; privacy?: string; schedule?: string; timezone: string;
    }) => {
      const sources = [opts.reelId, opts.video, opts.image?.length ? 'images' : undefined].filter(Boolean);
      if (sources.length > 1) {
        throw new CliError(
          'Provide only one source: --reel-id, --video, or --image.',
          'conflicting_source'
        );
      }
      if (sources.length === 0 && !opts.caption) {
        throw new CliError(
          'Nothing to post. Provide --reel-id, --video, --image, or a --caption for a text post.',
          'missing_source'
        );
      }

      const client = await createClient();
      const body: Parameters<typeof client.createSocialPost>[0] = {
        targets: opts.target,
        reel_id: opts.reelId,
        caption: opts.caption,
        title: opts.title,
        label: opts.label,
        privacy: opts.privacy,
        timezone: opts.timezone
      };

      if (opts.video) {
        body.video_url = (await resolveMediaInput(client, opts.video)).url;
      }
      if (opts.image?.length) {
        body.image_urls = [];
        for (const image of opts.image) {
          body.image_urls.push((await resolveMediaInput(client, image)).url);
        }
      }
      if (opts.schedule) {
        const asNumber = Number(opts.schedule);
        const scheduledAt = Number.isFinite(asNumber) && opts.schedule.trim() !== ''
          ? asNumber
          : opts.schedule;
        if (typeof scheduledAt === 'string' && Number.isNaN(Date.parse(scheduledAt))) {
          throw new CliError(
            `Invalid --schedule: ${opts.schedule}. Use epoch ms or an ISO timestamp.`,
            'invalid_schedule'
          );
        }
        body.scheduled_at = scheduledAt;
      }

      const post = await client.createSocialPost(body);
      printResult(post, () => {
        const when = new Date(post.scheduled_at_ms);
        process.stdout.write(`${green('✓')} Post ${post.status}\n`);
        process.stdout.write(`${dim('ID:')}       ${post.id}\n`);
        process.stdout.write(`${dim('Targets:')}  ${post.targets.join(', ')}\n`);
        process.stdout.write(`${dim('When:')}     ${when.toISOString()}\n`);
      });
    });

  social
    .command('lookup <path>')
    .description('Read public platform data (profiles, posts, transcripts, trends). Free.')
    .option('-p, --param <key=value...>', 'Query parameters forwarded to the endpoint')
    .action(async (path: string, opts: { param?: string[] }) => {
      const params: Record<string, string> = {};
      for (const entry of opts.param || []) {
        const index = entry.indexOf('=');
        if (index <= 0) {
          throw new CliError(`Invalid --param "${entry}". Use key=value.`, 'invalid_param');
        }
        params[entry.slice(0, index)] = entry.slice(index + 1);
      }
      const client = await createClient();
      const result = await client.socialLookup(path, params);
      // The upstream payload shape varies per endpoint, so print it verbatim.
      printResult(result, () => {
        process.stdout.write(`${bold(path)}\n`);
        printJson(result.data);
      });
    });
}
