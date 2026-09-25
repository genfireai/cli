import { Command } from 'commander';
import type { AdPlatform, GenFireClient } from '@genfire/sdk';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient, publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printJson, printResult, printTable, yellow } from '../output.js';
import { extractOutputUrls, resolveMediaInput } from '../runHelpers.js';

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

  registerAdRemixCommand(ads);
  registerAdsManagerCommands(ads);
}

// ── Ad Remix (POST /v1/ads/remix) ─────────────────────────────────────────────

export interface RemixChange {
  what?: string;
  description?: string;
  image_url?: string;
  preset?: string;
}

/**
 * `--change "outfit: a red denim jacket"` → { what, description }. The part
 * before the first colon is WHAT changes; everything after is the plain-English
 * detail. A bare phrase with no colon is a description of an unnamed change.
 */
export function parseRemixChange(spec: string): RemixChange {
  const idx = spec.indexOf(':');
  if (idx === -1) return { description: spec.trim() };
  const what = spec.slice(0, idx).trim();
  const description = spec.slice(idx + 1).trim();
  if (!description) throw new CliError(`--change "${spec}" has no description after the colon.`, 'invalid_change');
  return { ...(what ? { what } : {}), description };
}

/** `--change-image "creator=./face.png"` → [what, source]. */
export function parseRemixImageChange(spec: string): { what: string; source: string } {
  const idx = spec.indexOf('=');
  if (idx <= 0 || idx === spec.length - 1) {
    throw new CliError(`--change-image "${spec}" must look like WHAT=URL_OR_PATH (e.g. creator=./face.png).`, 'invalid_change');
  }
  return { what: spec.slice(0, idx).trim(), source: spec.slice(idx + 1).trim() };
}

/** `run_…` → that run's output URL; URL → as-is; local path → uploaded. */
async function resolveRemixMedia(client: GenFireClient, value: string): Promise<string> {
  if (/^run_[A-Za-z0-9_-]+$/.test(value)) {
    const run = await client.getRun(value);
    if (run.status !== 'completed') {
      throw new CliError(`Run ${value} is ${run.status}; only a completed run can be remixed or referenced.`, 'run_not_completed');
    }
    const url = extractOutputUrls(run, 'remix')[0]?.url;
    if (!url) throw new CliError(`Run ${value} has no media output.`, 'run_has_no_output');
    return url;
  }
  return (await resolveMediaInput(client, value)).url;
}

const collect = (value: string, previous: string[]): string[] => previous.concat([value]);

function registerAdRemixCommand(ads: Command): void {
  ads
    .command('remix <source>')
    .description(
      'Remix a winning ad — keep its cut, camera and pacing, change the creator, outfit, location, product, language… ' +
      'Quotes by default (free, nothing billed); pass --run to launch. <source> is a video URL, local path, or a past video run_id'
    )
    .option('--change <what:description>', 'A words-only change (repeatable), e.g. --change "location: a rooftop at dusk" --change "language: Spanish"', collect, [] as string[])
    .option('--change-image <what=urlOrPath>', 'A change shown with an image (repeatable), e.g. --change-image "outfit=./jacket.png" (creator faces are described, never sent with the footage)', collect, [] as string[])
    .option('--preset <name>', 'A named preset change (repeatable: look, location, time, weather, wardrobe, camera or language), e.g. --preset golden-hour --preset es', collect, [] as string[])
    .option('--direction <text>', 'Free-text direction appended to the single-variant remix')
    .option('--variants-file <path>', 'JSON array of variants [{ id?, changes: [...], direction?, audio? }] — ONLY when you want several versions (cost = segments × variants)')
    .option('--product-image <urlOrPath>', 'Pin the product on every call (stops it drifting) — URL, local path or image run_id')
    .option('--audio <mode>', 'generated (default) | original | none | an https audio URL')
    .option('-a, --aspect-ratio <ratio>', '9:16 (default) or 16:9 — match the source')
    .option('-r, --resolution <res>', '360p | 720p (default here — the draft tier) | 1080p | 4k')
    .option('--no-cards', 'Skip the per-variant picker cards (portraits, flat lays) included in the quote')
    .option('--run', 'Launch the run (bills credits). Without it you get the plan and the quote only')
    .action(async (source: string, opts: {
      change?: string[]; changeImage?: string[]; preset?: string[]; direction?: string; variantsFile?: string;
      productImage?: string; audio?: string; aspectRatio?: string; resolution?: string; cards: boolean; run?: boolean;
    }) => {
      if (opts.aspectRatio && !['9:16', '16:9'].includes(opts.aspectRatio)) {
        throw new CliError('--aspect-ratio must be 9:16 or 16:9', 'invalid_aspect_ratio');
      }
      if (opts.resolution && !['360p', '720p', '1080p', '4k'].includes(opts.resolution)) {
        throw new CliError('--resolution must be one of: 360p, 720p, 1080p, 4k', 'invalid_resolution');
      }
      const hasChanges = Boolean(opts.change?.length || opts.changeImage?.length || opts.preset?.length);
      if (hasChanges && opts.variantsFile) {
        throw new CliError('Use --change/--change-image/--preset for one variant, or --variants-file for several — not both.', 'invalid_arguments');
      }
      if (!hasChanges && !opts.variantsFile) {
        throw new CliError('Say what to change: --change, --change-image, --preset or --variants-file.', 'missing_changes');
      }

      let variants: unknown[] | undefined;
      if (opts.variantsFile) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(opts.variantsFile, 'utf8'));
        } catch (err) {
          throw new CliError(`Could not read --variants-file ${opts.variantsFile}: ${(err as Error).message}`, 'invalid_variants_file');
        }
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 12) {
          throw new CliError('--variants-file must hold a JSON array of 1-12 variants.', 'invalid_variants_file');
        }
        variants = parsed;
      }

      const client = await createClient();
      const changes: RemixChange[] = [
        ...(opts.change ?? []).map(parseRemixChange),
        ...(opts.preset ?? []).map((preset) => ({ preset })),
      ];
      for (const spec of opts.changeImage ?? []) {
        const { what, source: media } = parseRemixImageChange(spec);
        changes.push({ what, image_url: await resolveRemixMedia(client, media) });
      }
      if (changes.length > 10) {
        throw new CliError('At most 10 changes per variant.', 'too_many_changes');
      }

      let audio: unknown = opts.audio;
      if (opts.audio && /^https?:\/\//i.test(opts.audio)) audio = { mode: 'replace', url: opts.audio };
      else if (opts.audio && !['generated', 'original', 'none'].includes(opts.audio)) {
        throw new CliError('--audio must be generated, original, none or an https audio URL', 'invalid_audio');
      }

      const body: Record<string, unknown> = {
        source_video_url: await resolveRemixMedia(client, source),
        ...(opts.productImage ? { product_image_url: await resolveRemixMedia(client, opts.productImage) } : {}),
        ...(variants ? { variants } : { changes }),
        ...(opts.direction && !variants ? { direction: opts.direction } : {}),
        ...(audio ? { audio } : {}),
        ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
        // Same draft default as the MCP tool: the API's own default is 1080p,
        // ~10x the cost across the ladder.
        resolution: opts.resolution ?? '720p',
        ...(opts.cards === false ? { cards: false } : {}),
        dry_run: !opts.run
      };

      const result = await publicApiRequest<Record<string, any>>('POST', '/ads/remix', {
        body,
        ...(opts.run ? { idempotencyKey: randomUUID() } : {})
      });

      printResult(result, () => {
        if (result.dry_run || result.object === 'ad_remix_plan') {
          process.stdout.write(`${bold('Remix plan')} ${dim(`(${result.resolution ?? ''}, ${result.generation_count ?? '?'} generations)`)}\n`);
          process.stdout.write(`${dim('Estimate:')} ${cyan(String(result.estimated_credits ?? '?'))} credits ${dim('— nothing billed')}\n`);
          for (const w of Array.isArray(result.warnings) ? result.warnings : []) {
            process.stdout.write(`${yellow('!')} ${w}\n`);
          }
          if (result.note) process.stdout.write(`${dim(String(result.note))}\n`);
          process.stdout.write(`${dim('Launch with the same flags plus --run.')}\n`);
          return;
        }
        process.stderr.write(`${dim('Run queued:')} ${result.id ?? result.run_id} ${dim(`(${result.status ?? 'queued'})`)}\n`);
        process.stderr.write(`${dim('Poll it with:')} genfire runs get ${result.id ?? result.run_id}\n`);
      });
    });
}

// ── Meta Ads Manager (/v1/adsmanager/*) ───────────────────────────────────────

const DATE_PRESETS = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'maximum'];

function datePresetQuery(value: string | undefined): string {
  if (value === undefined) return '';
  if (!DATE_PRESETS.includes(value)) {
    throw new CliError(`--date-preset must be one of: ${DATE_PRESETS.join(', ')}`, 'invalid_date_preset');
  }
  return `?date_preset=${encodeURIComponent(value)}`;
}

/**
 * Spend-changing calls. The API itself can only ever STOP or LOWER spend
 * (activation and budget increases are dashboard-only), but both still act on a
 * live ad account, so the CLI refuses without an explicit --yes.
 */
function requireYes(yes: boolean | undefined, action: string): void {
  if (!yes) {
    throw new CliError(`${action} changes a live Meta ad account. Re-run with --yes to confirm.`, 'confirmation_required');
  }
}

function registerAdsManagerCommands(ads: Command): void {
  const manager = ads
    .command('manager')
    .description('Your connected Meta ad account: performance, experiments, and pause / lower-budget controls');

  manager
    .command('overview')
    .description('Connection status and the selected ad account (connecting Meta is a one-time dashboard step)')
    .action(async () => {
      const acct = await publicApiRequest<Record<string, any>>('GET', '/adsmanager/account');
      printResult(acct, () => {
        if (!acct.connected) {
          process.stdout.write(`${yellow('Not connected.')} Connect Meta in the dashboard: ${cyan(String(acct.connect_url ?? ''))}\n`);
          return;
        }
        const a = acct.ad_account ?? {};
        process.stdout.write(`${bold(String(a.name ?? 'Ad account'))} ${dim(String(a.id ?? ''))} ${dim(String(a.currency ?? ''))}\n`);
        process.stdout.write(`${dim('Ready to spend:')} ${acct.ready_to_spend ? green('yes') : yellow('no')}\n`);
        if (acct.needs_reconnect) process.stdout.write(`${yellow('Needs reconnect in the dashboard.')}\n`);
        if (Array.isArray(acct.missing_scopes) && acct.missing_scopes.length) {
          process.stdout.write(`${dim('Missing scopes:')} ${acct.missing_scopes.join(', ')}\n`);
        }
      });
    });

  manager
    .command('campaigns')
    .description('Campaigns with spend, ROAS and effective status')
    .option('--date-preset <preset>', `${DATE_PRESETS.join(' | ')} (default last_30d)`)
    .action(async (opts: { datePreset?: string }) => {
      const r = await publicApiRequest<Record<string, any>>('GET', `/adsmanager/campaigns${datePresetQuery(opts.datePreset)}`);
      printResult(r, () => {
        const rows = Array.isArray(r.campaigns) ? r.campaigns : [];
        if (!rows.length) {
          process.stdout.write(`${dim('No campaigns.')}\n`);
          return;
        }
        printTable(
          rows.map((c: any) => ({
            id: c.id,
            name: String(c.name ?? '').slice(0, 32),
            status: c.effective_status ?? c.status,
            spend: c.spend,
            roas: c.roas,
            ctr: c.ctr
          })),
          ['id', 'name', 'status', 'spend', 'roas', 'ctr']
        );
        if (r.currency) process.stdout.write(`${dim(`Currency: ${r.currency}`)}\n`);
      });
    });

  manager
    .command('campaign <campaignId>')
    .description('One campaign with its ad sets and ads')
    .option('--date-preset <preset>', `${DATE_PRESETS.join(' | ')} (default last_30d)`)
    .action(async (campaignId: string, opts: { datePreset?: string }) => {
      printJson(await publicApiRequest('GET', `/adsmanager/campaigns/${encodeURIComponent(campaignId)}${datePresetQuery(opts.datePreset)}`));
    });

  manager
    .command('experiment <adSetId>')
    .description('Read an ad set as an experiment: which creative is winning and whether it is significant')
    .option('--date-preset <preset>', `${DATE_PRESETS.join(' | ')} (default last_14d)`)
    .action(async (adSetId: string, opts: { datePreset?: string }) => {
      printJson(await publicApiRequest('GET', `/adsmanager/adsets/${encodeURIComponent(adSetId)}/experiment${datePresetQuery(opts.datePreset)}`));
    });

  manager
    .command('pause <entityId>')
    .description('Pause a campaign, ad set or ad (going live again is a dashboard action)')
    .option('--yes', 'Confirm: this stops spend on a live ad account')
    .action(async (entityId: string, opts: { yes?: boolean }) => {
      requireYes(opts.yes, 'Pausing');
      const r = await publicApiRequest<Record<string, any>>('POST', `/adsmanager/entities/${encodeURIComponent(entityId)}/pause`);
      printResult(r, () => {
        process.stdout.write(`${green('✓')} Paused ${entityId}\n`);
        if (r.note) process.stdout.write(`${dim(String(r.note))}\n`);
      });
    });

  manager
    .command('budget <entityId>')
    .description('LOWER a daily budget (increases are dashboard-only), in the ad account currency')
    .requiredOption('--daily <amount>', 'New daily budget — must be below the current one')
    .option('--yes', 'Confirm: this changes a live ad account')
    .action(async (entityId: string, opts: { daily: string; yes?: boolean }) => {
      const dailyBudget = Number(opts.daily);
      if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) {
        throw new CliError('--daily must be a positive number', 'invalid_budget');
      }
      requireYes(opts.yes, 'Changing a budget');
      const r = await publicApiRequest<Record<string, any>>('POST', `/adsmanager/entities/${encodeURIComponent(entityId)}/budget`, {
        body: { daily_budget: dailyBudget }
      });
      printResult(r, () => {
        process.stdout.write(`${green('✓')} ${entityId}: daily budget ${r.previous_daily_budget} → ${r.daily_budget}\n`);
      });
    });
}
