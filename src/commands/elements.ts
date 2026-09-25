import { Command } from 'commander';
import { GenFireApiError, type Element } from '@genfire/sdk';
import { createClient, publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { resolveMediaInput } from '../runHelpers.js';
import { bold, cyan, dim, green, printResult, printTable } from '../output.js';

export function registerElementsCommand(program: Command): void {
  const elements = program.command('elements').description('Create and manage reusable image elements (@handle props)');

  elements
    .command('create <name>')
    .description('Create a reusable element from a single image (URL or local path)')
    .requiredOption('-i, --image <urlOrPath>', 'Element image URL or local path (auto-uploaded).')
    .option('-h, --handle <handle>', 'Short @-mention handle (auto-derived from the name if omitted)')
    .option('-a, --aspect <ratio>', 'Aspect ratio of the image, e.g. 1:1 or 9:16 (informational)')
    .option('--project <projectId>', 'Also file the element into this project')
    .action(async (name: string, opts: { image: string; handle?: string; aspect?: string; project?: string }) => {
      const client = await createClient();
      // Auto-upload a local path; pass an https URL through unchanged.
      const resolved = await resolveMediaInput(client, opts.image);
      // The pinned SDK's createElement builds its body field by field and has
      // no project_id, so a filed element goes straight to POST /v1/elements.
      const element: Element & { project_id?: string | null } = opts.project
        ? await publicApiRequest('POST', '/elements', {
            body: {
              name,
              image_url: resolved.url,
              ...(opts.handle ? { handle: opts.handle } : {}),
              ...(opts.aspect ? { aspect_ratio: opts.aspect } : {}),
              project_id: opts.project
            }
          })
        : await client.createElement({
            name,
            imageUrl: resolved.url,
            handle: opts.handle,
            aspectRatio: opts.aspect
          });
      printResult(element, () => {
        process.stdout.write(`${green('✓')} Created ${bold('@' + element.handle)}  ${element.name}\n`);
        process.stdout.write(`${dim('ID:')}    ${element.id}\n`);
        if (element.image_url) {
          process.stdout.write(`${dim('Image:')} ${cyan(element.image_url)}\n`);
        }
        if (opts.project) {
          process.stdout.write(
            element.project_id
              ? `${dim('Project:')} ${element.project_id}\n`
              : `${dim(`Not filed into ${opts.project} (the element was still created).`)}\n`
          );
        }
        process.stdout.write(
          `\n${dim(`Use in prompts: genfire generate video "@${element.handle} on a marble table" --model seedance_2_0`)}\n`
        );
      });
    });

  elements
    .command('list')
    .description('List your reusable image elements')
    .action(async () => {
      const client = await createClient();
      const response = await client.listElements();
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No elements yet.')}\n`);
          process.stdout.write(`${dim('Create one: genfire elements create "Red Bottle" -i ./bottle.png')}\n`);
          return;
        }
        printTable(
          response.data.map((e) => ({
            handle: '@' + (e.handle || '(unset)'),
            name: e.name,
            id: e.id,
            source: e.source_type,
            updated: e.updated_at.replace('T', ' ').slice(0, 19)
          })),
          ['handle', 'name', 'id', 'source', 'updated']
        );
        process.stdout.write(
          `\n${dim('Use in prompts: genfire generate video "@<handle> on a table" --model seedance_2_0')}\n`
        );
      });
    });

  elements
    .command('get <elementId>')
    .description('Show full details for one element')
    .action(async (id: string) => {
      const client = await createClient();
      try {
        const e = await client.getElement(id);
        printResult(e, () => {
          process.stdout.write(`${bold('@' + e.handle)}  ${e.name}\n`);
          process.stdout.write(`${dim('ID:')}      ${e.id}\n`);
          process.stdout.write(`${dim('Source:')}  ${e.source_type}\n`);
          if (e.aspect_ratio) process.stdout.write(`${dim('Aspect:')}  ${e.aspect_ratio}\n`);
          if (e.image_url) process.stdout.write(`${dim('Image:')}   ${cyan(e.image_url)}\n`);
          process.stdout.write(`${dim('Created:')} ${e.created_at}\n`);
          process.stdout.write(`${dim('Updated:')} ${e.updated_at}\n`);
        });
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Element not found: ${id}`, 'element_not_found');
        }
        throw err;
      }
    });

  elements
    .command('delete <elementId>')
    .description('Delete an element (the image itself is unaffected)')
    .action(async (id: string) => {
      const client = await createClient();
      try {
        await client.deleteElement(id);
        process.stdout.write(`${green('✓')} Deleted element ${id}\n`);
      } catch (err) {
        if (err instanceof GenFireApiError && err.status === 404) {
          throw new CliError(`Element not found: ${id}`, 'element_not_found');
        }
        throw err;
      }
    });
}
