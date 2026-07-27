import { Command } from 'commander';
import { GenFireApiError } from '@genfire/sdk';
import type { Brand } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { waitForRun } from '../runHelpers.js';
import { bold, cyan, dim, green, printResult, printTable, yellow } from '../output.js';

// Shared detail renderer for a single brand (get / update).
function printBrand(b: Brand): void {
  printResult(b, () => {
    process.stdout.write(`${bold(b.name)}${b.tagline ? dim('  — ' + b.tagline) : ''}\n`);
    process.stdout.write(`${dim('ID:')}       ${b.id}\n`);
    process.stdout.write(`${dim('Status:')}   ${b.status === 'ready' ? green(b.status) : yellow(b.status)}\n`);
    process.stdout.write(`${dim('Website:')}  ${cyan(b.website_url)}\n`);
    if (b.style) process.stdout.write(`${dim('Style:')}    ${b.style}\n`);
    if (b.logo_url) process.stdout.write(`${dim('Logo:')}     ${cyan(b.logo_url)}\n`);
    if (b.colors.length) {
      process.stdout.write(`${dim('Colors:')}   ${b.colors.map((c) => `${c.hex} (${c.role})`).join(', ')}\n`);
    }
    if (b.fonts.length) {
      process.stdout.write(`${dim('Fonts:')}    ${b.fonts.map((f) => `${f.name} (${f.role})`).join(', ')}\n`);
    }
    if (b.voice) {
      process.stdout.write(`${dim('Voice:')}    ${b.voice.summary}\n`);
      if (b.voice.tone_adjectives.length) {
        process.stdout.write(`${dim('Tone:')}     ${b.voice.tone_adjectives.join(', ')}\n`);
      }
    }
    if (b.products && b.products.length) {
      process.stdout.write(`\n${dim('Products:')}\n`);
      for (const p of b.products) {
        process.stdout.write(`  • ${bold(p.name)}${p.price ? dim('  ' + p.price) : ''}\n`);
        if (p.usps.length) {
          process.stdout.write(`    ${dim(p.usps.join(' · '))}\n`);
        }
      }
    }
    process.stdout.write(`${dim('Created:')}  ${b.created_at}\n`);
    process.stdout.write(`${dim('Updated:')}  ${b.updated_at}\n`);
  });
}

export function registerBrandsCommand(program: Command): void {
  const brands = program.command('brands').description('Ingest, inspect, and edit your brand profiles');

  brands
    .command('ingest <url>')
    .description('Build a brand profile from a website URL (logo, colors, fonts, voice, products). Free; ~30–90s.')
    .option('--no-wait', 'Return the queued run immediately instead of polling until the brand is ready.')
    .action(async (url: string, opts: { wait: boolean }) => {
      const client = await createClient();
      process.stdout.write(`${dim('Ingesting ' + url + ' (rendering site, extracting brand kit, analyzing voice)…')}\n`);
      const run = await client.createBrandFromUrl(url);

      if (!opts.wait) {
        printResult(run, () => {
          process.stdout.write(`${green('✓')} Queued brand ingestion\n`);
          process.stdout.write(`${dim('Run:')}   ${run.id}\n`);
          process.stdout.write(`${dim(`Poll with: genfire runs get ${run.id}`)}\n`);
        });
        return;
      }

      let lastStage = '';
      const completed = await waitForRun(client, run.id, {
        onTick: (r) => {
          const stage = r.progress?.label || r.status;
          if (stage && stage !== lastStage) {
            lastStage = stage;
            process.stdout.write(`${dim('  · ' + stage + '…')}\n`);
          }
        }
      });

      if (completed.status === 'failed') {
        throw new CliError(
          completed.error?.message || 'Brand ingestion failed.',
          completed.error?.code || 'ingestion_failed'
        );
      }

      const brandId =
        (completed.output?.brand_id as string | undefined) || completed.resource_id || '';
      if (!brandId) {
        throw new CliError('Ingestion completed but no brand id was returned.', 'no_brand_id');
      }

      const brand = await client.getBrand(brandId);
      process.stdout.write(`${green('✓')} Brand ready\n`);
      printBrand(brand);
    });

  brands
    .command('list')
    .description('List your brand profiles')
    .action(async () => {
      const client = await createClient();
      const response = await client.listBrands();
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No brands yet.')}\n`);
          process.stdout.write(`${dim('Create one: genfire brands ingest https://example.com')}\n`);
          return;
        }
        printTable(
          response.data.map((b) => ({
            name: b.name,
            id: b.id,
            status: b.status,
            website: b.website_url,
            updated: b.updated_at.replace('T', ' ').slice(0, 19)
          })),
          ['name', 'id', 'status', 'website', 'updated']
        );
      });
    });

  brands
    .command('get <brandId>')
    .description('Show a full brand profile including its scraped products')
    .action(async (id: string) => {
      const client = await createClient();
      try {
        const brand = await client.getBrand(id);
        printBrand(brand);
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Brand not found: ${id}`, 'brand_not_found');
        }
        throw err;
      }
    });

  brands
    .command('update <brandId>')
    .description('Edit brand fields (only the flags you pass are changed)')
    .option('--name <name>', 'Brand name')
    .option('--tagline <tagline>', 'Tagline')
    .option('--description <text>', 'Short brand description')
    .option('--style <style>', 'Visual style label, e.g. modern | premium | vibrant')
    .option('--logo-url <url>', 'Header/lockup logo URL')
    .option('--icon-url <url>', 'Square mark/icon URL')
    .option('--language <lang>', 'Default language, e.g. en')
    .option('--country <country>', 'Default country, e.g. US')
    .action(async (
      id: string,
      opts: {
        name?: string;
        tagline?: string;
        description?: string;
        style?: string;
        logoUrl?: string;
        iconUrl?: string;
        language?: string;
        country?: string;
      }
    ) => {
      const fields: Partial<
        Pick<
          Brand,
          'name' | 'tagline' | 'description' | 'style' | 'logo_url' | 'icon_url' | 'default_language' | 'default_country'
        >
      > = {};
      if (opts.name !== undefined) fields.name = opts.name;
      if (opts.tagline !== undefined) fields.tagline = opts.tagline;
      if (opts.description !== undefined) fields.description = opts.description;
      if (opts.style !== undefined) fields.style = opts.style;
      if (opts.logoUrl !== undefined) fields.logo_url = opts.logoUrl;
      if (opts.iconUrl !== undefined) fields.icon_url = opts.iconUrl;
      if (opts.language !== undefined) fields.default_language = opts.language;
      if (opts.country !== undefined) fields.default_country = opts.country;

      if (Object.keys(fields).length === 0) {
        throw new CliError(
          'Nothing to update. Pass at least one flag, e.g. --name, --tagline, --style.',
          'no_fields'
        );
      }

      const client = await createClient();
      try {
        const brand = await client.updateBrand(id, fields);
        process.stdout.write(`${green('✓')} Updated brand ${id}\n`);
        printBrand(brand);
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Brand not found: ${id}`, 'brand_not_found');
        }
        throw err;
      }
    });

  brands
    .command('delete <brandId>')
    .description('Delete a brand profile and its products')
    .action(async (id: string) => {
      const client = await createClient();
      try {
        await client.deleteBrand(id);
        process.stdout.write(`${green('✓')} Deleted brand ${id}\n`);
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Brand not found: ${id}`, 'brand_not_found');
        }
        throw err;
      }
    });

  brands
    .command('add-product <brandId>')
    .description('Add a product to a brand — from a product-page URL, or manually')
    .option('--url <url>', 'Product-page URL to scrape (auto-pulls name/price/images)')
    .option('--name <name>', 'Product name (manual entry)')
    .option('--price <price>', 'Price (manual entry)')
    .option('--description <text>', 'Description (manual entry)')
    .option('--image <url...>', 'Product image URL(s) (manual entry, repeatable)')
    .action(async (id: string, opts: { url?: string; name?: string; price?: string; description?: string; image?: string[] }) => {
      if (!opts.url && !opts.name) {
        throw new CliError('Provide --url to scrape, or --name for a manual product.', 'invalid_product');
      }
      const client = await createClient();
      try {
        const product = opts.url
          ? await client.addBrandProduct(id, { url: opts.url })
          : await client.addBrandProduct(id, {
              name: opts.name ?? '',
              ...(opts.price ? { price: opts.price } : {}),
              ...(opts.description ? { description: opts.description } : {}),
              ...(opts.image ? { images: opts.image } : {}),
            });
        printResult(product, () => {
          process.stdout.write(`${bold(product.name)}  ${dim(product.id)}\n`);
          if (product.price) process.stdout.write(`${dim('Price:')} ${product.price}\n`);
          if (product.images?.length) process.stdout.write(`${dim('Images:')} ${product.images.length}\n`);
        });
        process.stdout.write(`${green('✓')} Added product "${product.name}" to brand ${id}\n`);
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Brand not found: ${id}`, 'brand_not_found');
        }
        throw err;
      }
    });

  brands
    .command('delete-product <brandId> <productId>')
    .description('Remove a product from a brand')
    .action(async (id: string, productId: string) => {
      const client = await createClient();
      try {
        await client.deleteBrandProduct(id, productId);
        process.stdout.write(`${green('✓')} Deleted product ${productId}\n`);
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Brand or product not found`, 'not_found');
        }
        throw err;
      }
    });
}
