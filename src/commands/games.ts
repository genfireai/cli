import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, yellow } from '../output.js';
import { resolveMediaInput, waitForRun } from '../runHelpers.js';

/** Parse a duration like `180s`, `2m`, or a bare number of seconds, into ms. */
function parseDurationMs(value: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m)?$/.exec(value.trim());
  if (!match) throw new CliError(`Invalid duration for ${flag}: ${value}`, 'invalid_duration');
  const n = parseFloat(match[1]);
  return Math.round(n * (match[2] === 'm' ? 60_000 : 1_000));
}

export function registerGamesCommand(program: Command): void {
  const games = program.command('games').description('Generate and publish playable browser games');

  games
    .command('create <prompt>')
    .description('Build a playable browser game from a prompt; generates asynchronously, then prints the public play_url')
    .option('-g, --game-id <id>', 'Iterate on an existing game (re-generates in place at the same URL)')
    .option('-m, --model <model>', 'Codegen model (e.g. claude-opus-5). Defaults to Opus.')
    .option('-a, --asset <urlOrPath...>', 'Asset URL or local path (auto-uploaded) to wire in as sprites/textures/audio. Up to 16.')
    .option('--multiplayer', 'Build with realtime multiplayer (play-with-friends via the Genfire relay)')
    .option('--wait-timeout <duration>', 'Max time to wait for the build', '180s')
    .option('--wait-interval <duration>', 'Polling interval', '3s')
    .action(async (prompt: string, opts: {
      gameId?: string; model?: string; asset?: string[]; multiplayer?: boolean;
      waitTimeout: string; waitInterval: string;
    }) => {
      const client = await createClient();

      // Auto-upload any local asset paths; pass https URLs through.
      let assetUrls: string[] | undefined;
      if (opts.asset && opts.asset.length > 0) {
        if (opts.asset.length > 16) {
          throw new CliError('At most 16 assets are supported (-a/--asset).', 'too_many_assets');
        }
        assetUrls = [];
        for (const asset of opts.asset) {
          const resolved = await resolveMediaInput(client, asset);
          assetUrls.push(resolved.url);
        }
      }

      const run = await client.generateGame(
        {
          prompt,
          game_id: opts.gameId,
          model: opts.model,
          asset_urls: assetUrls,
          multiplayer: opts.multiplayer || undefined
        },
        { idempotencyKey: randomUUID() }
      );

      process.stderr.write(`${dim(`Building game (run ${run.id})...`)}\n`);
      const finished = await waitForRun(client, run.id, {
        intervalMs: parseDurationMs(opts.waitInterval, '--wait-interval'),
        timeoutMs: parseDurationMs(opts.waitTimeout, '--wait-timeout'),
        onTick: (current, elapsed) => {
          if (current.status !== 'completed' && current.status !== 'failed') {
            process.stderr.write(`${dim(`  status=${current.status} elapsed=${Math.round(elapsed / 1000)}s\r`)}`);
          }
        }
      });
      process.stderr.write('\n');

      if (finished.status !== 'completed') {
        throw new CliError(
          `Game build ${finished.id} ${finished.status}${finished.error ? `: ${finished.error.message}` : ''}`,
          'game_generation_failed'
        );
      }

      const output = (finished.output || {}) as { game_id?: string; play_url?: string; title?: string; thumbnail_url?: string };
      printResult(finished, () => {
        process.stdout.write(`${green('✓')} ${bold(output.title || 'Game')} built\n`);
        if (output.game_id) process.stdout.write(`${dim('Game ID:')} ${output.game_id}\n`);
        if (output.play_url) process.stdout.write(`${dim('Play:')}    ${cyan(output.play_url)}\n`);
        process.stdout.write(`\n${dim(`Iterate: genfire games create "add a boss" -g ${output.game_id || '<id>'}`)}\n`);
        process.stdout.write(`${dim(`Publish: genfire games publish ${output.game_id || '<id>'}`)}\n`);
      });
    });

  games
    .command('publish <gameId>')
    .description('Publish a completed game to the public Genfire gallery (genfire.ai/games)')
    .action(async (gameId: string) => {
      const client = await createClient();
      const result = await publishGame(client, gameId, true);
      printResult(result, () => {
        process.stdout.write(`${green('✓')} Published ${bold(gameId)} to the public gallery.\n`);
      });
    });

  games
    .command('unpublish <gameId>')
    .description('Remove a game from the public Genfire gallery (it stays playable via its play_url)')
    .action(async (gameId: string) => {
      const client = await createClient();
      const result = await publishGame(client, gameId, false);
      printResult(result, () => {
        process.stdout.write(`${yellow('✓')} Unpublished ${bold(gameId)} — removed from the public gallery.\n`);
      });
    });
}

async function publishGame(
  client: import('@genfire/sdk').GenFireClient,
  gameId: string,
  publish: boolean
): Promise<import('@genfire/sdk').PublishGameResponse> {
  try {
    return await client.publishGame(gameId, publish);
  } catch (err) {
    const { GenFireApiError } = await import('@genfire/sdk');
    if (err instanceof GenFireApiError && err.status === 404) {
      throw new CliError(
        `Game not found, not yours, or not completed: ${gameId}`,
        'game_not_publishable'
      );
    }
    throw err;
  }
}
