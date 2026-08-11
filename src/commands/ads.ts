import { Command } from 'commander';
import type { AdPlatform } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printJson, printResult, printTable } from '../output.js';

const PLATFORMS = new Set<AdPlatform>(['meta', 'google', 'linkedin', 'reddit']);

/** days_running is the performance proxy: 45+ days means the ad is proven. */
function provenMarker(days: unknown): string {
  const n = typeof days === 'number' ? days : Number(days);
  if (!Number.isFinite(n)) return '';
  return n >= 45 ? green(`${n}d ✓`) : `${n}d`;
}

export function registerAdsCommand(program: Command): void {
  const ads = program
    .command('ads')
    .description('Research competitor ads and extract reusable ad formats');

  ads
    .command('search')
    .description('Search competitor ad libraries. Free.')
    .option('-q, --query <text>', 'Brand/company name, or a niche phrase with --mode niche')
    .option('--page-id <id>', 'Meta page id (brand mode)')
    .option('-p, --platform <platform>', 'meta (default) | google | linkedin | reddit', 'meta')
    .option('-m, --mode <mode>', 'brand (default) searches one advertiser; niche searches a category', 'brand')
    .option('-n, --limit <count>', 'Results per page, 1–50', '20')
    .option('--cursor <cursor>', 'Page cursor from a previous result')
    .action(async (opts: {
      query?: string; pageId?: string; platform: string; mode: string; limit: string; cursor?: string;
    }) => {
      if (!opts.query && !opts.pageId) {
        throw new CliError('Provide --query <brand or niche> or --page-id.', 'missing_query');
      }
      if (!PLATFORMS.has(opts.platform as AdPlatform)) {
        throw new CliError(
          `Invalid --platform: ${opts.platform}. Use ${[...PLATFORMS].join(', ')}.`,
          'invalid_platform'
        );
      }
      if (opts.mode !== 'brand' && opts.mode !== 'niche') {
        throw new CliError(`Invalid --mode: ${opts.mode}. Use brand or niche.`, 'invalid_mode');
      }
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new CliError(`Invalid --limit: ${opts.limit}. Use 1–50.`, 'invalid_limit');
      }

      const client = await createClient();
      const response = await client.searchAds({
        query: opts.query,
        page_id: opts.pageId,
        platform: opts.platform as AdPlatform,
        mode: opts.mode,
        limit,
        cursor: opts.cursor
      });

      printResult(response, () => {
        if (response.company) {
          const name = (response.company as Record<string, unknown>).name;
          if (name) process.stdout.write(`${bold(String(name))}\n`);
        }
        printTable(
          response.data.map((ad) => {
            const a = ad as Record<string, unknown>;
            return {
              ad_id: a.ad_id ? String(a.ad_id) : '—',
              page_id: a.page_id ? String(a.page_id) : '—',
              running: provenMarker(a.days_running),
              text: a.body_text ? String(a.body_text).replace(/\s+/g, ' ').slice(0, 60) : '—'
            };
          }),
          ['ad_id', 'page_id', 'running', 'text']
        );
        process.stdout.write(`${dim('45+ days running (✓) is the proven-performance signal.')}\n`);
        if (response.next_cursor) {
          process.stdout.write(`${dim('Next page:')} --cursor ${response.next_cursor}\n`);
        }
        process.stdout.write(`${dim('Analyze one with:')} genfire ads analyze --page-id <id> --ad-id <id>\n`);
      });
    });

  ads
    .command('analyze')
    .description('Extract the reusable format from one ad and store it for cloning')
    .requiredOption('--page-id <id>', 'Page id from a search result')
    .requiredOption('--ad-id <id>', 'Ad id from a search result')
    .action(async (opts: { pageId: string; adId: string }) => {
      const client = await createClient();
      const research = await client.analyzeAd({ page_id: opts.pageId, ad_id: opts.adId });
      printResult(research, () => {
        process.stdout.write(`${green('✓')} Analyzed\n`);
        process.stdout.write(`${dim('Research ID:')} ${research.research_id}\n`);
        if (research.mirrored_video_url) {
          process.stdout.write(`${dim('Video:')}       ${cyan(research.mirrored_video_url)}\n`);
        }
        process.stdout.write(`\n${dim('─── analysis ───')}\n`);
        printJson(research.analysis);
        process.stdout.write(
          `${dim('Clone this format for your own product: pass')} reference_ad_research_id=${research.research_id} ` +
          `${dim('to the ugc_ad_video workflow. Wording and assets are never copied.')}\n`
        );
      });
    });

  ads
    .command('get <researchId>')
    .description('Re-read a stored ad analysis')
    .action(async (researchId: string) => {
      const client = await createClient();
      const research = await client.getAdResearch(researchId);
      printResult(research, () => {
        process.stdout.write(`${dim('Research ID:')} ${research.research_id}\n`);
        if (research.mirrored_video_url) {
          process.stdout.write(`${dim('Video:')}       ${cyan(research.mirrored_video_url)}\n`);
        }
        process.stdout.write(`\n${dim('─── analysis ───')}\n`);
        printJson(research.analysis);
      });
    });
}
