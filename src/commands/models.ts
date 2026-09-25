import { Command } from 'commander';
import { Model } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, printResult, printTable } from '../output.js';

function modelsToRows(models: Model[]) {
  return models.map((model) => ({
    id: model.id,
    capability: model.capability,
    name: model.name,
    default: model.is_default ? 'yes' : '',
    inputs: summarizeCapabilities(model)
  }));
}

function summarizeCapabilities(model: Model): string {
  if (!model.capabilities) return '';
  const flags: string[] = [];
  if (model.capabilities.text_to_output) flags.push('t2o');
  if (model.capabilities.image_to_output) flags.push('i2o');
  if (model.capabilities.reference_images) flags.push('ref');
  if (model.capabilities.source_video) flags.push('v2v');
  if (model.capabilities.motion_control) flags.push('motion');
  if (model.capabilities.first_last_frame) flags.push('flf');
  // Newer flags the pinned SDK's Model type does not declare yet.
  const extra = model.capabilities as unknown as Record<string, unknown>;
  if (extra.end_frame) flags.push('end');
  if (extra.reference_media) flags.push('refav');
  if (extra.keyframes) flags.push('kf');
  if (extra.video_task) flags.push('task');
  if (extra.masked_inpaint) flags.push('mask');
  if (extra.camera_trajectory) flags.push('cam');
  if (extra.video_styles) flags.push('style');
  return flags.join(',');
}

export function registerModelsCommand(program: Command): void {
  const models = program.command('models').description('Inspect the model catalog');

  models
    .command('list')
    .description('List all available models')
    .option('-c, --capability <capability>', 'Filter by capability (e.g. image_generation, video_generation)')
    .action(async (options: { capability?: string }) => {
      const client = await createClient();
      const response = await client.listModels();
      const filtered = options.capability
        ? response.data.filter((model) => model.capability === options.capability)
        : response.data;

      printResult({ object: 'list', data: filtered }, () => {
        if (filtered.length === 0) {
          process.stdout.write(`${dim('No models match.')}\n`);
          return;
        }
        printTable(modelsToRows(filtered), ['id', 'capability', 'name', 'default', 'inputs']);
        process.stdout.write(
          `\n${dim(`Inputs key: t2o = text-to-output, i2o = image-to-output, ref = reference images, v2v = source video, motion = motion control, flf = first/last frame, end = end frame, refav = reference video/audio, kf = keyframes, task = Gedi task, mask = inpaint mask, cam = camera path, style = video styles`)}\n`
        );
      });
    });

  models
    .command('get <id>')
    .description('Show full details for one model, including its live credit price')
    .action(async (id: string) => {
      const client = await createClient();
      // GET /v1/models carries no price; the rate lives on GET /v1/models/pricing
      // (keyed by model id). Joined here the way MCP genfire_get_model does, so
      // `--json` has a real `price` object instead of nothing.
      const [response, pricing] = await Promise.all([
        client.listModels(),
        client.listPricing().catch(() => null)
      ]);
      const found = response.data.find((entry) => entry.id === id);

      if (!found) {
        const needle = id.toLowerCase();
        const near = response.data
          .filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(needle.replace(/^[a-z_0-9]+\./, '')))
          .slice(0, 8)
          .map((m) => m.id);
        throw new CliError(
          `Model not found: ${id}.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} Run \`genfire models search <text>\` or \`genfire models list\`.`,
          'model_not_found'
        );
      }
      const price = pricing?.data.find((row) => row.model === found.id) as
        | { credits: number; unit: string; notes?: string; operation_key?: string }
        | undefined;
      const model = {
        ...found,
        ...(price ? { price: { credits: price.credits, unit: price.unit, notes: price.notes ?? null } } : {})
      };

      printResult(model, () => {
        process.stdout.write(`${bold(model.name)}  ${dim(model.id)}${model.is_default ? ' ' + cyan('(default)') : ''}\n`);
        process.stdout.write(`${dim('Capability:')}  ${model.capability}\n`);
        process.stdout.write(`${dim('Status:')}      ${model.status}\n`);
        process.stdout.write(`${dim('Description:')} ${model.description}\n`);
        if (price) {
          process.stdout.write(`${dim('Price:')}       ${cyan(String(price.credits))} credits ${dim(price.unit.replace(/_/g, ' '))}\n`);
          if (price.notes) process.stdout.write(`${dim(`             ${price.notes}`)}\n`);
          process.stdout.write(`${dim(`             Exact quote for a config: genfire cost ${costKind(model.capability)} -m ${model.id} …`)}\n`);
        } else {
          process.stdout.write(`${dim('Price:')}       ${dim('no flat rate — use genfire cost for a quote')}\n`);
        }

        if (model.capabilities) {
          const flags = Object.entries(model.capabilities)
            .filter(([, value]) => value)
            .map(([key]) => key.replace(/_/g, ' '));
          if (flags.length > 0) {
            process.stdout.write(`${dim('Inputs:')}      ${flags.join(', ')}\n`);
          }
        }

        if (model.limits && Object.keys(model.limits).length > 0) {
          process.stdout.write(`${dim('Limits:')}\n`);
          for (const [key, value] of Object.entries(model.limits)) {
            process.stdout.write(`  ${dim(`${key}:`)} ${formatLimit(value)}\n`);
          }
        }
      });
    });

  models
    .command('search [query...]')
    .description('Search the catalog by id, name or description (all words must match), optionally within one capability')
    .option('-c, --capability <capability>', 'Narrow to one capability, e.g. video_generation')
    .option('-l, --limit <n>', 'Max results', '20')
    .action(async (queryWords: string[] | undefined, options: { capability?: string; limit: string }) => {
      const query = (queryWords ?? []).join(' ');
      const client = await createClient();
      const [response, pricing] = await Promise.all([
        client.listModels(),
        client.listPricing().catch(() => null)
      ]);
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = response.data.filter((m) => {
        if (options.capability && m.capability !== options.capability) return false;
        const hay = `${m.id} ${m.name} ${m.description}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
      const limit = Math.max(1, Number(options.limit) || 20);
      const priceOf = new Map((pricing?.data ?? []).map((row) => [row.model, row]));
      const data = matches.slice(0, limit).map((m) => {
        const p = priceOf.get(m.id);
        return p ? { ...m, price: { credits: p.credits, unit: p.unit } } : m;
      });
      printResult({ object: 'list', total: matches.length, data }, () => {
        if (data.length === 0) {
          process.stdout.write(`${dim('No models match.')}\n`);
          return;
        }
        printTable(
          data.map((m) => {
            const p = priceOf.get(m.id);
            return {
              id: m.id,
              capability: m.capability,
              name: m.name,
              price: p ? `${p.credits} ${p.unit.replace(/^per_/, '/')}` : '',
              inputs: summarizeCapabilities(m)
            };
          }),
          ['id', 'capability', 'name', 'price', 'inputs']
        );
        if (matches.length > data.length) {
          process.stdout.write(`${dim(`${matches.length - data.length} more — raise --limit or narrow the search`)}\n`);
        }
      });
    });

  models
    .command('pricing')
    .description('Show per-model credit pricing')
    .option('-c, --capability <capability>', 'Filter by capability')
    .action(async (options: { capability?: string }) => {
      const client = await createClient();
      const response = await client.listPricing();
      const filtered = options.capability
        ? response.data.filter((entry) => entry.capability === options.capability)
        : response.data;

      printResult({ object: 'list', data: filtered }, () => {
        if (filtered.length === 0) {
          process.stdout.write(`${dim('No pricing entries match.')}\n`);
          return;
        }
        printTable(
          filtered.map((entry) => ({
            model: entry.model,
            capability: entry.capability,
            credits: entry.credits,
            unit: entry.unit
          })),
          ['model', 'capability', 'credits', 'unit']
        );
      });
    });
}

/** The `genfire cost` subcommand that prices a capability. */
function costKind(capability: string): string {
  const map: Record<string, string> = {
    image_generation: 'image',
    image_editing: 'image',
    video_generation: 'video',
    speech_generation: 'speech',
    music_generation: 'music',
    sound_effect_generation: 'sfx',
    model_3d_generation: '3d',
    lipsync_generation: 'lipsync',
    transcription: 'transcribe',
    video_upscaling: 'upscale-video'
  };
  return map[capability] ?? 'request <file.json> #';
}

function formatLimit(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
