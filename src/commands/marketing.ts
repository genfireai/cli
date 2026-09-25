import { Command } from 'commander';
import { publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable } from '../output.js';

/**
 * Marketing Studio catalog over `/v1/marketing/*`.
 *
 * Read-only browse surface (templates, the format/hook/setting catalog, avatars,
 * stored products) plus `add-product`, which scrapes a product page onto one of
 * your brands so its id can fill a template's product slot.
 *
 * There is deliberately no `marketing run`: a template RUNS through
 * `genfire generate image|video --template <id>` (and prices through
 * `genfire cost` with the same flags) — the MCP server's
 * genfire_ad_template_estimate / _run are widget-only compositions over those
 * same two routes, not endpoints of their own.
 */

type Query = Record<string, string | number | boolean | undefined>;

/** `?a=1&b=2` from the defined entries, or '' when none are. */
export function queryString(params: Query): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    qs.set(key, String(value));
  }
  const q = qs.toString();
  return q ? `?${q}` : '';
}

const AD_FORMATS = ['product-shot', 'motion', 'ugc', 'ads', 'posters', 'marketplace'];
const MEDIA_TYPES = ['image', 'video'];

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new CliError('--limit must be an integer 1-100', 'invalid_limit');
  }
  return n;
}

function oneOf(value: string | undefined, allowed: string[], flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new CliError(`${flag} must be one of: ${allowed.join(', ')}`, 'invalid_option');
  }
  return value;
}

function short(value: unknown, max = 60): string {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface ListPage {
  object?: string;
  data: Array<Record<string, any>>;
  next_cursor?: string | null;
  has_more?: boolean;
}

function printNextCursor(page: ListPage): void {
  if (page.next_cursor) {
    process.stdout.write(`${dim(`More — continue with --cursor ${page.next_cursor}`)}\n`);
  }
}

export function registerMarketingCommand(program: Command): void {
  const marketing = program
    .command('marketing')
    .description('Marketing Studio: ad templates, the format/hook/setting catalog, avatars and products');

  marketing
    .command('templates')
    .description('Browse curated ad templates (run one with `genfire generate image|video --template <id>`)')
    .option('-q, --search <text>', 'Match title, description, format and recipe direction (all words must appear)')
    .option('--ad-format <format>', `Kind of ad: ${AD_FORMATS.join(', ')}`)
    .option('--media-type <type>', 'image | video')
    .option('--requires-avatar', 'Only templates with a person in frame')
    .option('-l, --limit <n>', 'Page size 1-100 (default 24)')
    .option('--cursor <cursor>', 'next_cursor from a previous page')
    .action(async (opts: {
      search?: string; adFormat?: string; mediaType?: string; requiresAvatar?: boolean; limit?: string; cursor?: string;
    }) => {
      const query = queryString({
        search: opts.search,
        ad_format: oneOf(opts.adFormat, AD_FORMATS, '--ad-format'),
        media_type: oneOf(opts.mediaType, MEDIA_TYPES, '--media-type'),
        requires_avatar: opts.requiresAvatar ? 'true' : undefined,
        limit: parseLimit(opts.limit),
        cursor: opts.cursor
      });
      const page = await publicApiRequest<ListPage>('GET', `/marketing/templates${query}`);
      printResult(page, () => {
        if (!page.data?.length) {
          process.stdout.write(`${dim('No templates match.')}\n`);
          return;
        }
        printTable(
          page.data.map((t) => ({
            id: t.id,
            title: short(t.title, 40),
            format: t.ad_format ?? '',
            media: t.media_type ?? '',
            aspect: t.aspect_ratio ?? '',
            needs: Array.isArray(t.recipe?.required_inputs) ? t.recipe.required_inputs.join(',') : ''
          })),
          ['id', 'title', 'format', 'media', 'aspect', 'needs']
        );
        printNextCursor(page);
      });
    });

  marketing
    .command('template <templateId>')
    .description('Show one ad template: its recipe, required inputs and sibling variants')
    .action(async (templateId: string) => {
      const t = await publicApiRequest<Record<string, any>>(
        'GET',
        `/marketing/templates/${encodeURIComponent(templateId)}`
      );
      printResult(t, () => {
        process.stdout.write(`${bold(String(t.title ?? t.id))}  ${dim(String(t.id))}\n`);
        if (t.ad_format) process.stdout.write(`${dim('Format:')}   ${t.ad_format}\n`);
        if (t.media_type) process.stdout.write(`${dim('Media:')}    ${t.media_type}\n`);
        if (t.aspect_ratio) process.stdout.write(`${dim('Aspect:')}   ${t.aspect_ratio}\n`);
        if (t.description) process.stdout.write(`${dim('About:')}    ${t.description}\n`);
        const recipe = t.recipe ?? {};
        if (Array.isArray(recipe.required_inputs) && recipe.required_inputs.length) {
          process.stdout.write(`${dim('Requires:')} ${recipe.required_inputs.join(', ')}\n`);
        }
        if (Array.isArray(recipe.optional_inputs) && recipe.optional_inputs.length) {
          process.stdout.write(`${dim('Optional:')} ${recipe.optional_inputs.join(', ')}\n`);
        }
        const preview = t.media_url ?? t.thumbnail_url ?? t.poster_url;
        if (preview) process.stdout.write(`${dim('Preview:')}  ${cyan(String(preview))}\n`);
        if (t.recipe?.model) process.stdout.write(`${dim('Model:')}    ${t.recipe.model}\n`);
        if (Array.isArray(t.siblings) && t.siblings.length) {
          process.stdout.write(`${dim('Siblings:')} ${t.siblings.map((s: any) => s.id).join(', ')}\n`);
        }
        const verb = t.media_type === 'video' ? 'video' : 'image';
        process.stdout.write(
          `\n${dim(`Run it: genfire generate ${verb} "<what to change>" --template ${t.id} --product-image ./product.png`)}\n`
        );
      });
    });

  marketing
    .command('catalog')
    .description('The creative vocabulary: ad formats, genres (formats), opening hooks and settings')
    .option('-q, --search <text>', 'Narrow formats, hooks and settings by keyword (ad formats always return in full)')
    .option('--mode <mode>', 'image | video — only formats and hooks that apply to this kind of generation')
    .option('--hook-type <type>', 'Only hooks of this type, e.g. stunt | subtle')
    .option('--setting-category <category>', 'Only settings in this category')
    .option('--ad-format <format>', 'Only genres belonging to this ad format')
    .action(async (opts: { search?: string; mode?: string; hookType?: string; settingCategory?: string; adFormat?: string }) => {
      const mode = oneOf(opts.mode, MEDIA_TYPES, '--mode');
      const [adFormats, formats, hooks, settings] = await Promise.all([
        publicApiRequest<ListPage>('GET', '/marketing/ad-formats'),
        publicApiRequest<ListPage>('GET', `/marketing/formats${queryString({ search: opts.search, mode, ad_format: opts.adFormat })}`),
        publicApiRequest<ListPage>('GET', `/marketing/hooks${queryString({ search: opts.search, mode, type: opts.hookType })}`),
        publicApiRequest<ListPage>('GET', `/marketing/settings${queryString({ search: opts.search, category: opts.settingCategory })}`)
      ]);
      const result = {
        ad_formats: adFormats.data ?? [],
        formats: formats.data ?? [],
        hooks: hooks.data ?? [],
        settings: settings.data ?? []
      };
      printResult(result, () => {
        const section = (title: string, rows: Array<Record<string, any>>, flag: string) => {
          process.stdout.write(`\n${bold(title)} ${dim(`(${rows.length}${flag ? ` — pass as ${flag}` : ''})`)}\n`);
          if (!rows.length) {
            process.stdout.write(`${dim('  none')}\n`);
            return;
          }
          printTable(
            rows.map((r) => ({
              id: r.id,
              name: short(r.name ?? r.title ?? r.label, 32),
              about: short(r.description ?? r.summary ?? '', 60)
            })),
            ['id', 'name', 'about']
          );
        };
        section('Ad formats', result.ad_formats, '');
        section('Formats (genre)', result.formats, '--format');
        section('Hooks (opening mechanic)', result.hooks, '--hook');
        section('Settings (environment)', result.settings, '--setting');
      });
    });

  marketing
    .command('avatars')
    .description('Avatars that fill a template\'s avatar slot — your trained influencers and the house library')
    .option('-q, --search <text>', 'Match name, handle and scene/gender/age tags')
    .option('--source <source>', 'user (your influencers) | preset (house library)')
    .option('--scene <scene>', 'House-library scene: ugc | car | studio | podcast | interview | lifestyle | office | outdoor')
    .option('--gender <gender>', 'male | female | neutral')
    .option('--age <age>', 'young-adult | adult | middle-aged | senior')
    .option('-l, --limit <n>', 'Page size 1-100')
    .option('--cursor <cursor>', 'next_cursor from a previous page')
    .action(async (opts: {
      search?: string; source?: string; scene?: string; gender?: string; age?: string; limit?: string; cursor?: string;
    }) => {
      const query = queryString({
        search: opts.search,
        source: oneOf(opts.source, ['user', 'preset'], '--source'),
        scene: opts.scene,
        gender: oneOf(opts.gender, ['male', 'female', 'neutral'], '--gender'),
        age: oneOf(opts.age, ['young-adult', 'adult', 'middle-aged', 'senior'], '--age'),
        limit: parseLimit(opts.limit),
        cursor: opts.cursor
      });
      const page = await publicApiRequest<ListPage>('GET', `/marketing/avatars${query}`);
      printResult(page, () => {
        if (!page.data?.length) {
          process.stdout.write(`${dim('No avatars match.')}\n`);
          return;
        }
        printTable(
          page.data.map((a) => ({
            id: a.id,
            name: short(a.name ?? a.handle, 32),
            source: a.source ?? '',
            tags: [a.scene, a.gender, a.age].filter(Boolean).join(',')
          })),
          ['id', 'name', 'source', 'tags']
        );
        printNextCursor(page);
      });
    });

  marketing
    .command('products')
    .description('Stored brand products that fill a template\'s product slot (pass the id as --product)')
    .option('--brand <brandId>', 'Only this brand\'s products')
    .option('-q, --search <text>', 'Match product name')
    .option('-l, --limit <n>', 'Page size 1-100')
    .option('--cursor <cursor>', 'next_cursor from a previous page')
    .action(async (opts: { brand?: string; search?: string; limit?: string; cursor?: string }) => {
      const query = queryString({
        brand_id: opts.brand,
        search: opts.search,
        limit: parseLimit(opts.limit),
        cursor: opts.cursor
      });
      const page = await publicApiRequest<ListPage>('GET', `/marketing/products${query}`);
      printResult(page, () => {
        if (!page.data?.length) {
          process.stdout.write(`${dim('No products. Add one: genfire marketing add-product --brand <id> --url <product page>')}\n`);
          return;
        }
        printTable(
          page.data.map((p) => ({
            id: p.id,
            name: short(p.name, 40),
            brand: p.brand_id ?? '',
            source: p.source ?? ''
          })),
          ['id', 'name', 'brand', 'source']
        );
        printNextCursor(page);
      });
    });

  marketing
    .command('add-product')
    .description('Scrape a product page onto one of your brands, so its id can fill a template\'s product slot')
    .requiredOption('--brand <brandId>', 'Brand to store the product on (see: genfire brands list)')
    .requiredOption('--url <url>', 'Product page URL to read')
    .option('--title <title>', 'Override the scraped product name')
    .option('--description <text>', 'Override the scraped description')
    .action(async (opts: { brand: string; url: string; title?: string; description?: string }) => {
      const product = await publicApiRequest<Record<string, any>>('POST', '/marketing/products', {
        body: {
          brand_id: opts.brand,
          url: opts.url,
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.description ? { description: opts.description } : {})
        }
      });
      printResult(product, () => {
        process.stdout.write(`${green('✓')} Stored ${bold(String(product.name ?? ''))}\n`);
        process.stdout.write(`${dim('ID:')}    ${product.id}\n`);
        if (product.image_url) process.stdout.write(`${dim('Image:')} ${cyan(String(product.image_url))}\n`);
        process.stdout.write(`${dim('Use it: --product')} ${product.id}\n`);
      });
    });
}
