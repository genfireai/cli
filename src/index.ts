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
import { registerBatchCommands } from './commands/batch.js';
import { registerRunsCommand } from './commands/runs.js';
import { registerCostCommand } from './commands/cost.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { registerFacelessReelsCommand } from './commands/faceless-reels.js';
import { registerExplainersCommand } from './commands/explainers.js';
import { registerInfluencersCommand } from './commands/influencers.js';
import { registerElementsCommand } from './commands/elements.js';
import { registerBrandsCommand } from './commands/brands.js';
import { registerGamesCommand } from './commands/games.js';
import { registerVoicesCommand } from './commands/voices.js';
import { registerMusicVideosCommand } from './commands/music-videos.js';
import { registerBooksCommand } from './commands/books.js';
import { registerColoringCommand } from './commands/coloring.js';
import { registerWebhooksCommand } from './commands/webhooks.js';
import { registerDocumentsCommand } from './commands/documents.js';
import { registerSkillsCommand } from './commands/skills.js';
import { registerAppsCommand } from './commands/apps.js';
import { registerSocialCommand } from './commands/social.js';
import { registerAdsCommand } from './commands/ads.js';
import { registerUsageCommand } from './commands/usage.js';
import { registerMcpCommand } from './commands/mcp.js';
import { isInteractiveTty, launchTui } from './tui/launch.js';

import { VERSION } from './versionCheck.js';

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('genfire')
    .description('Genfire generative media CLI')
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
  registerBatchCommands(program);
  registerRunsCommand(program);
  registerCostCommand(program);
  registerWorkflowCommands(program);
  registerFacelessReelsCommand(program);
  registerExplainersCommand(program);
  registerInfluencersCommand(program);
  registerElementsCommand(program);
  registerBrandsCommand(program);
  registerGamesCommand(program);
  registerVoicesCommand(program);
  registerMusicVideosCommand(program);
  registerBooksCommand(program);
registerColoringCommand(program);
  registerWebhooksCommand(program);
  registerDocumentsCommand(program);
  registerSkillsCommand(program);
  registerAppsCommand(program);
  registerSocialCommand(program);
  registerAdsCommand(program);
  registerUsageCommand(program);
  registerMcpCommand(program);

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
    // Tokens are minted with the scope set the CLI requested at login time, so a
    // token issued by an older CLI lacks scopes newer commands need (webhooks,
    // social, …). Re-authenticating re-mints it with the current defaults.
    if (err.code === 'insufficient_scope') {
      process.stderr.write(
        'This token was issued without that scope. Run `genfire auth login` to re-authenticate ' +
        'with the current scope set.\n'
      );
    }
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
