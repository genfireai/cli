import { Command } from 'commander';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, printResult, yellow } from '../output.js';

interface CostOptions {
  model: string;
  count?: string;
  duration?: string;
}

interface CostEstimate {
  model: string;
  capability: string;
  unit: string;
  per_call_credits: number;
  multiplier: number;
  estimated_credits: number;
  notes: string[];
}

export function registerCostCommand(program: Command): void {
  const cost = program.command('cost').description('Estimate the credit cost of a generation before running it');

  cost
    .command('image <prompt>')
    .description('Estimate the credit cost of an image generation')
    .requiredOption('-m, --model <model>', 'Public model alias, e.g. image.nano_banana_2')
    .option('-n, --count <n>', 'Number of images', '1')
    .action(async (_prompt: string, opts: CostOptions) => {
      await runEstimate(opts.model, { multiplier: Number(opts.count || 1), kind: 'image' });
    });

  cost
    .command('video <prompt>')
    .description('Estimate the credit cost of a video generation')
    .requiredOption('-m, --model <model>', 'Public model alias, e.g. video.veo_3_1')
    .option('-d, --duration <seconds>', 'Duration in seconds (used as a per-second multiplier when the unit is per_second)', '5')
    .action(async (_prompt: string, opts: CostOptions) => {
      await runEstimate(opts.model, { multiplier: Number(opts.duration || 5), kind: 'video' });
    });

  cost
    .command('speech <text>')
    .description('Estimate the credit cost of a speech generation')
    .requiredOption('-m, --model <model>', 'Public speech model alias')
    .action(async (text: string, opts: CostOptions) => {
      const characters = text.length;
      await runEstimate(opts.model, { multiplier: characters, kind: 'speech', label: `${characters} characters` });
    });

  cost
    .command('music <prompt>')
    .description('Estimate the credit cost of a music generation')
    .requiredOption('-m, --model <model>', 'Public music model alias')
    .option('-d, --duration <seconds>', 'Duration in seconds', '30')
    .action(async (_prompt: string, opts: CostOptions) => {
      await runEstimate(opts.model, { multiplier: Number(opts.duration || 30), kind: 'music' });
    });

  cost
    .command('sfx <prompt>')
    .description('Estimate the credit cost of a sound effect generation')
    .requiredOption('-m, --model <model>', 'Public SFX model alias')
    .option('-d, --duration <seconds>', 'Duration in seconds', '5')
    .action(async (_prompt: string, opts: CostOptions) => {
      await runEstimate(opts.model, { multiplier: Number(opts.duration || 5), kind: 'sfx' });
    });
}

async function runEstimate(modelId: string, params: { multiplier: number; kind: string; label?: string }): Promise<void> {
  const client = await createClient();
  const [pricing, credits] = await Promise.all([
    client.listPricing(),
    client.getCredits().catch(() => null)
  ]);

  const entry = pricing.data.find((row) => row.model === modelId);
  if (!entry) {
    throw new CliError(
      `No pricing entry for model: ${modelId}. Run \`genfire models pricing\` to see priced models.`,
      'unknown_model'
    );
  }

  const multiplier = effectiveMultiplier(entry.unit, params.multiplier);
  const estimated = entry.credits * multiplier;
  const notes: string[] = [];
  if (entry.unit === 'per_call' && params.multiplier > 1) {
    notes.push(`Unit is per_call, so the ${params.label || `multiplier (${params.multiplier})`} value does not affect the estimate.`);
  }
  if (entry.notes) notes.push(entry.notes);
  notes.push('Estimate is approximate — actual cost may vary based on model-specific multipliers (e.g. resolution, aspect, audio).');

  const result: CostEstimate = {
    model: entry.model,
    capability: entry.capability,
    unit: entry.unit,
    per_call_credits: entry.credits,
    multiplier,
    estimated_credits: estimated,
    notes
  };

  printResult(
    {
      ...result,
      balance: credits ? { balance: credits.balance, currency: credits.currency } : undefined
    },
    () => {
      process.stdout.write(`${bold(entry.model)}  ${dim(entry.capability)}\n`);
      process.stdout.write(`${dim('Unit:')}      ${entry.unit}\n`);
      process.stdout.write(`${dim('Per call:')}  ${entry.credits} credits\n`);
      if (multiplier !== 1) {
        process.stdout.write(`${dim('Multiplier:')} ×${multiplier}\n`);
      }
      process.stdout.write(`${dim('Estimate:')}  ${cyan(String(estimated))} credits\n`);
      if (credits) {
        const remaining = credits.balance - estimated;
        const tag = remaining < 0 ? yellow(`(would go negative by ${-remaining})`) : `(${remaining} remaining)`;
        process.stdout.write(`${dim('Balance:')}   ${credits.balance} ${tag}\n`);
      }
      for (const note of notes) {
        process.stdout.write(`${dim('Note:')} ${note}\n`);
      }
    }
  );
}

function effectiveMultiplier(unit: string, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 1;
  switch (unit) {
    case 'per_call':
      return 1;
    case 'per_second':
    case 'per_image':
    case 'per_character':
      return Math.ceil(requested);
    default:
      return Math.ceil(requested);
  }
}
