#!/usr/bin/env node

import { registerRuntimeCommands } from './commands/runtime.js';
import { Command } from 'commander';
import { formatError } from './errors.js';
import { setGlobalFlags } from './output.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerAccountCommand } from './commands/account.js';
import { registerModelsCommand } from './commands/models.js';
import { registerCreditsCommand } from './commands/credits.js';
import { registerGenerateCommands } from './commands/generate.js';
import { registerBatchCommands } from './commands/batch.js';
import { registerRunsCommand } from './commands/runs.js';
import { registerCostCommand } from './commands/cost.js';
import { registerMediaCommands } from './commands/media.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { registerTimelineCommands } from './commands/timeline.js';
import { registerPresetCommands } from './commands/presets.js';
import { registerGediCommand } from './commands/gedi.js';
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
import { registerProjectsCommand } from './commands/projects.js';
import { registerWorkspacesCommand } from './commands/workspaces.js';
import { registerMoodboardsCommand } from './commands/moodboards.js';
import { registerTrainingCommands } from './commands/training.js';
import { registerComposeCommand } from './commands/compose.js';
import { registerMarketingCommand } from './commands/marketing.js';
import { registerTasksCommand } from './commands/tasks.js';
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
  registerMediaCommands(program);
  registerRuntimeCommands(program);
  registerWorkflowCommands(program);
  registerTimelineCommands(program);
  registerPresetCommands(program);
  registerGediCommand(program);
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
  registerProjectsCommand(program);
  registerWorkspacesCommand(program);
  registerMoodboardsCommand(program);
  registerTrainingCommands(program);
  registerComposeCommand(program);
  registerMarketingCommand(program);
  registerTasksCommand(program);

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
  const { lines, exitCode } = formatError(err);
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exit(exitCode);
}

main().catch(reportError);
