#!/usr/bin/env node

import { Command } from 'commander';
import { GenFireApiError } from '@genfire/sdk';
import { CliError } from './errors.js';
import { setGlobalFlags } from './output.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerAccountCommand } from './commands/account.js';
import { registerModelsCommand } from './commands/models.js';
import { registerCreditsCommand } from './commands/credits.js';
import { registerGenerateCommands } from './commands/generate.js';
import { registerRunsCommand } from './commands/runs.js';
import { registerCostCommand } from './commands/cost.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { registerInfluencersCommand } from './commands/influencers.js';
import { isInteractiveTty, launchTui } from './tui/launch.js';

const VERSION = '0.3.0';

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('genfire')
    .description('GenFire generative media CLI')
    .version(VERSION)
    .option('--json', 'Emit machine-readable JSON to stdout instead of pretty output')
    .option('--no-color', "Disable ANSI color in pretty output")
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      setGlobalFlags({ json: Boolean(opts.json), noColor: Boolean(opts.noColor) });
    });

  registerAuthCommands(program);
  registerAccountCommand(program);
  registerCreditsCommand(program);
  registerModelsCommand(program);
  registerGenerateCommands(program);
  registerRunsCommand(program);
  registerCostCommand(program);
  registerWorkflowCommands(program);
  registerInfluencersCommand(program);

  // No subcommand + interactive terminal? Drop into the TUI shell.
  // No subcommand + piped/CI? Print help and exit (preserves scriptability).
  const argv = process.argv.slice(2);
  const flagsOnly = argv.every((arg) => arg.startsWith('-'));
  const helpRequested = argv.includes('-h') || argv.includes('--help') || argv.includes('-V') || argv.includes('--version');

  if (argv.length === 0 || (flagsOnly && !helpRequested)) {
    if (isInteractiveTty()) {
      await launchTui();
      return;
    }
    program.outputHelp();
    return;
  }

  await program.parseAsync(process.argv);
}

function reportError(err: unknown): void {
  if (err instanceof CliError) {
    process.stderr.write(`Error (${err.code}): ${err.message}\n`);
    process.exit(err.exitCode);
  }
  if (err instanceof GenFireApiError) {
    process.stderr.write(`API error ${err.status} (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  if (err instanceof Error) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`Unknown error: ${String(err)}\n`);
  process.exit(1);
}

main().catch(reportError);
