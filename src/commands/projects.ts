import { Command } from 'commander';
import { publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable } from '../output.js';

/**
 * Projects — `/v1/projects`. The API's filing folders: they hold videos,
 * images, audio and elements, nest one level (project → folders) and can be
 * shared with a workspace. For NEW work, prefer `--project <id>` on the
 * generate command, which files the result automatically on completion; these
 * commands organise what already exists.
 *
 * The installed SDK (0.23.0) has no project methods, so every call goes
 * through `publicApiRequest`. None of these routes sit behind
 * `requireIdempotencyKey` — filing is de-duplicated by asset id server-side.
 */

export type ProjectAssetType = 'video' | 'image' | 'audio' | 'element';

export interface ProjectItemInput {
  asset_id: string;
  asset_type: ProjectAssetType;
  title?: string;
}

interface ProjectRecord {
  id: string;
  object: 'project';
  name: string;
  description: string | null;
  brief: string | null;
  parent_id: string | null;
  is_folder: boolean;
  cover_url: string | null;
  team_id: string | null;
  role: string | null;
  item_count: number;
  items?: Array<{
    asset_id: string;
    asset_type: ProjectAssetType;
    title: string;
    url: string | null;
    thumbnail_url: string | null;
    added_at: string | null;
  }>;
  created_at: string | null;
  updated_at: string | null;
  added?: number;
  removed?: number;
}

/** Mirrors the route's own cap — a project holds 500 items; one call files up to 50. */
const MAX_ITEMS_PER_CALL = 50;

const collect = (value: string, previous: string[]) => previous.concat([value]);

/**
 * `--image a --image b --video c` → the `{ items: [...] }` body POST
 * /projects/:id/items takes. Exported for the tests: the route 400s on any
 * other shape (asset_id + asset_type are both required, type from a closed set).
 */
export function buildProjectItems(
  opts: { image?: string[]; video?: string[]; audio?: string[]; element?: string[]; title?: string }
): ProjectItemInput[] {
  const items: ProjectItemInput[] = [];
  const push = (ids: string[] | undefined, assetType: ProjectAssetType) => {
    for (const raw of ids ?? []) {
      const assetId = raw.trim();
      if (!assetId) continue;
      if (/^https?:\/\//i.test(assetId)) {
        throw new CliError(
          `--${assetType} takes the asset's id, not its URL (${assetId}).`,
          'invalid_project_items'
        );
      }
      items.push({ asset_id: assetId, asset_type: assetType, ...(opts.title ? { title: opts.title } : {}) });
    }
  };
  push(opts.image, 'image');
  push(opts.video, 'video');
  push(opts.audio, 'audio');
  push(opts.element, 'element');
  if (items.length === 0) {
    throw new CliError(
      'Name at least one asset: --image <id>, --video <id>, --audio <id> or --element <id> (repeatable).',
      'invalid_project_items'
    );
  }
  if (items.length > MAX_ITEMS_PER_CALL) {
    throw new CliError(`At most ${MAX_ITEMS_PER_CALL} items per call (got ${items.length}).`, 'too_many_items');
  }
  return items;
}

function projectPath(projectId: string, suffix = ''): string {
  return `/projects/${encodeURIComponent(projectId)}${suffix}`;
}

function printProjectSummary(p: ProjectRecord): void {
  process.stdout.write(`${bold(p.name)}  ${dim(p.id)}${p.is_folder ? ' ' + dim('(folder)') : ''}\n`);
  if (p.parent_id) process.stdout.write(`${dim('Parent:')}   ${p.parent_id}\n`);
  if (p.description) process.stdout.write(`${dim('About:')}    ${p.description}\n`);
  if (p.brief) process.stdout.write(`${dim('Brief:')}    ${p.brief}\n`);
  if (p.team_id) process.stdout.write(`${dim('Team:')}     ${p.team_id}\n`);
  if (p.role) process.stdout.write(`${dim('Role:')}     ${p.role}\n`);
  process.stdout.write(`${dim('Items:')}    ${p.item_count}\n`);
}

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command('projects')
    .description('Organise assets into projects (folders of videos, images, audio and elements)');

  projects
    .command('list')
    .description('List the projects you own or that are shared with you')
    .option('--parent <projectId>', 'Only the folders inside this project; pass "root" for top-level projects only')
    .action(async (opts: { parent?: string }) => {
      const query = opts.parent ? `?parent_id=${encodeURIComponent(opts.parent)}` : '';
      const response = await publicApiRequest<{ object: 'list'; data: ProjectRecord[] }>('GET', `/projects${query}`);
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No projects yet.')}\n`);
          process.stdout.write(`${dim('Create one: genfire projects create "Spring campaign"')}\n`);
          return;
        }
        printTable(
          response.data.map((p) => ({
            id: p.id,
            name: p.is_folder ? `  └ ${p.name}` : p.name,
            items: p.item_count,
            role: p.role ?? '',
            team: p.team_id ?? '',
            updated: (p.updated_at ?? '').replace('T', ' ').slice(0, 19)
          })),
          ['id', 'name', 'items', 'role', 'team', 'updated']
        );
        process.stdout.write(`\n${dim('File new work into one: genfire generate image "…" --project <id>')}\n`);
      });
    });

  projects
    .command('get <projectId>')
    .description('Show a project and its items (with media URLs you can feed back into a generation)')
    .action(async (projectId: string) => {
      const project = await publicApiRequest<ProjectRecord>('GET', projectPath(projectId));
      printResult(project, () => {
        printProjectSummary(project);
        const items = project.items ?? [];
        if (items.length === 0) return;
        process.stdout.write('\n');
        printTable(
          items.map((i) => ({
            asset_id: i.asset_id,
            type: i.asset_type,
            title: (i.title || '').slice(0, 48),
            url: i.url ?? dim('(pending)')
          })),
          ['asset_id', 'type', 'title', 'url']
        );
      });
    });

  projects
    .command('create <name>')
    .description('Create a project (or a folder inside one with --parent)')
    .option('-d, --description <text>', 'Short description')
    .option('--parent <projectId>', 'Create this as a folder inside an existing project (one level deep)')
    .action(async (name: string, opts: { description?: string; parent?: string }) => {
      if (!name.trim()) throw new CliError('Project name is required.', 'invalid_project_name');
      const project = await publicApiRequest<ProjectRecord>('POST', '/projects', {
        body: {
          name,
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.parent ? { parent_id: opts.parent } : {})
        }
      });
      printResult(project, () => {
        process.stdout.write(`${green('✓')} Created ${bold(project.name)}  ${dim(project.id)}\n`);
        process.stdout.write(`${dim(`File work into it: genfire generate image "…" --project ${project.id}`)}\n`);
      });
    });

  projects
    .command('update <projectId>')
    .description('Rename a project, set its creative brief, or move it')
    .option('-n, --name <name>', 'New name')
    .option('-b, --brief <text>', "The project's creative brief")
    .option('--parent <projectId>', 'Move under this project as a folder')
    .option('--no-parent', 'Move back to the top level')
    .action(async (projectId: string, opts: { name?: string; brief?: string; parent?: string | boolean }) => {
      const body: Record<string, unknown> = {};
      if (opts.name !== undefined) body.name = opts.name;
      if (opts.brief !== undefined) body.brief = opts.brief;
      // commander: --parent <id> → string, --no-parent → false, neither → true (the default).
      if (typeof opts.parent === 'string') body.parent_id = opts.parent;
      else if (opts.parent === false) body.parent_id = null;
      if (Object.keys(body).length === 0) {
        throw new CliError('Provide at least one of --name, --brief, --parent or --no-parent.', 'invalid_project_update');
      }
      const project = await publicApiRequest<ProjectRecord>('PATCH', projectPath(projectId), { body });
      printResult(project, () => {
        process.stdout.write(`${green('✓')} Updated\n`);
        printProjectSummary(project);
      });
    });

  projects
    .command('delete <projectId>')
    .description('Delete a project (the media inside it stays in your library)')
    .action(async (projectId: string) => {
      const result = await publicApiRequest<{ id: string; deleted: boolean }>('DELETE', projectPath(projectId));
      printResult(result, () => {
        process.stdout.write(`${green('✓')} Deleted project ${projectId}\n`);
      });
    });

  projects
    .command('add <projectId>')
    .description('File existing assets into a project by asset id (re-filing is a no-op). For new work prefer --project on generate.')
    .option('--image <assetId>', 'Image asset id (repeatable)', collect, [] as string[])
    .option('--video <assetId>', 'Video asset id — a video run\'s resource_id (repeatable)', collect, [] as string[])
    .option('--audio <assetId>', 'Audio asset id (repeatable)', collect, [] as string[])
    .option('--element <elementId>', 'Element id from `genfire elements list` (repeatable)', collect, [] as string[])
    .option('--title <title>', 'Label for the filed item(s)')
    .action(async (projectId: string, opts: { image: string[]; video: string[]; audio: string[]; element: string[]; title?: string }) => {
      const items = buildProjectItems(opts);
      const project = await publicApiRequest<ProjectRecord>('POST', projectPath(projectId, '/items'), { body: { items } });
      printResult(project, () => {
        const added = project.added ?? items.length;
        const skipped = items.length - added;
        process.stdout.write(
          `${green('✓')} Filed ${cyan(String(added))} item(s) into ${bold(project.name)}` +
          `${skipped > 0 ? dim(` (${skipped} already there)`) : ''}  ${dim(`${project.item_count} total`)}\n`
        );
      });
    });

  projects
    .command('remove <projectId> <assetIds...>')
    .description('Unfile assets from a project by asset id (the media itself is NOT deleted)')
    .action(async (projectId: string, assetIds: string[]) => {
      const ids = assetIds.map((id) => id.trim()).filter(Boolean);
      if (ids.length === 0) throw new CliError('Name at least one asset id.', 'invalid_project_items');
      if (ids.length > MAX_ITEMS_PER_CALL) {
        throw new CliError(`At most ${MAX_ITEMS_PER_CALL} ids per call (got ${ids.length}).`, 'too_many_items');
      }
      const project = await publicApiRequest<ProjectRecord>('DELETE', projectPath(projectId, '/items'), {
        body: { asset_ids: ids }
      });
      printResult(project, () => {
        process.stdout.write(
          `${green('✓')} Removed ${cyan(String(project.removed ?? ids.length))} item(s) from ${bold(project.name)}  ` +
          `${dim(`${project.item_count} left`)}\n`
        );
      });
    });
}
