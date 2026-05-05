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
          `\n${dim(`Inputs key: t2o = text-to-output, i2o = image-to-output, ref = reference images, v2v = source video, motion = motion control, flf = first/last frame`)}\n`
        );
      });
    });

  models
    .command('get <id>')
    .description('Show full details for one model')
    .action(async (id: string) => {
      const client = await createClient();
      const response = await client.listModels();
      const model = response.data.find((entry) => entry.id === id);

      if (!model) {
        throw new CliError(`Model not found: ${id}. Run \`genfire models list\` to see available models.`, 'model_not_found');
      }

      printResult(model, () => {
        process.stdout.write(`${bold(model.name)}  ${dim(model.id)}${model.is_default ? ' ' + cyan('(default)') : ''}\n`);
        process.stdout.write(`${dim('Capability:')}  ${model.capability}\n`);
        process.stdout.write(`${dim('Status:')}      ${model.status}\n`);
        process.stdout.write(`${dim('Description:')} ${model.description}\n`);

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

function formatLimit(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
