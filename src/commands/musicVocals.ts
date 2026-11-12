import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { createClient, publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, yellow } from '../output.js';
import { downloadOutputs, resolveMediaInput } from '../runHelpers.js';
import { collect } from '../generationRequests.js';

/**
 * Music VOCALS / STYLES (ElevenLabs Music Finetunes) and STEM SEPARATION:
 *
 *   vocals   /v1/audio/music/vocals         list, get, estimate, create (billed), delete
 *   stems    /v1/audio/stem-separations     estimate, split (billed)
 *
 * The installed @genfire/sdk predates these routes, so every call goes through
 * `publicApiRequest` (same auth + base URL as the SDK client). The two POST
 * submits sit behind `requireIdempotencyKey`, so each sends a fresh
 * `Idempotency-Key`.
 */

export const VOCAL_KINDS = ['vocal', 'style'] as const;
export const VOCAL_SOURCES = ['curated', 'own'] as const;
export const STEM_VARIATIONS = ['two_stems_v1', 'six_stems_v1'] as const;
const VOCAL_MAX_TRACKS = 50;

function parseOneOf<T extends string>(value: string | undefined, flag: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw new CliError(`Invalid ${flag}: ${value}. Use ${allowed.join(', ')}.`, 'invalid_arguments');
  }
  return normalized as T;
}

/** `two` / `six` shorthands, or the full variation id. */
export function parseStemVariation(value: string | undefined): (typeof STEM_VARIATIONS)[number] | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'two' || v === '2') return 'two_stems_v1';
  if (v === 'six' || v === '6') return 'six_stems_v1';
  return parseOneOf(v, '--stems', STEM_VARIATIONS);
}

export interface VocalCreateFlags {
  genre: string;
  kind?: string;
  tag?: string[];
  team?: string;
  quote?: string;
}

/** The POST /v1/audio/music/vocals body. Pure, so the wire shape is testable. */
export function buildVocalCreateBody(name: string, trackUrls: string[], flags: VocalCreateFlags): Record<string, unknown> {
  const trimmed = name.trim();
  if (trimmed.length < 5 || trimmed.length > 200) {
    throw new CliError('A vocal name is 5-200 characters.', 'invalid_name');
  }
  if (!flags.genre || !flags.genre.trim()) {
    throw new CliError('--genre is required (the main genre of the tracks, e.g. pop).', 'invalid_genre');
  }
  if (trackUrls.length < 1 || trackUrls.length > VOCAL_MAX_TRACKS) {
    throw new CliError(`A vocal trains on 1-${VOCAL_MAX_TRACKS} tracks (got ${trackUrls.length}).`, 'invalid_track_count');
  }
  const kind = parseOneOf(flags.kind, '--kind', VOCAL_KINDS);
  return {
    name: trimmed,
    primary_genre: flags.genre.trim(),
    track_urls: trackUrls,
    ...(kind ? { kind } : {}),
    ...(flags.tag && flags.tag.length > 0 ? { tags: flags.tag } : {}),
    ...(flags.team ? { team_id: flags.team } : {}),
    ...(flags.quote ? { quote_token: flags.quote } : {})
  };
}

function printEstimate(estimate: any): void {
  printResult(estimate, () => {
    process.stdout.write(`${bold(String(estimate.capability ?? ''))}\n`);
    process.stdout.write(`${dim('Cost:')}     ${cyan(String(estimate.credits))} credits\n`);
    for (const [key, value] of Object.entries((estimate.breakdown ?? {}) as Record<string, unknown>)) {
      process.stdout.write(`${dim(`  ${key}:`)} ${String(value)}\n`);
    }
    if (estimate.quote_token) {
      process.stdout.write(
        `${dim('Quote:')}    ${estimate.quote_token}${estimate.expires_at ? dim(` (expires ${estimate.expires_at})`) : ''}\n`
      );
    }
  });
}

async function resolveAll(inputs: string[]): Promise<string[]> {
  if (inputs.every((input) => /^https?:\/\//i.test(input))) return inputs;
  const client = await createClient();
  const urls: string[] = [];
  for (const input of inputs) urls.push((await resolveMediaInput(client, input)).url);
  return urls;
}

function registerVocals(program: Command): void {
  const vocals = program
    .command('vocals')
    .description('Music VOCALS (singers) and STYLES (sounds) to sing with: `genfire generate music --vocal <id>`');

  vocals
    .command('list')
    .description('List curated vocals/styles plus your own')
    .option('--kind <kind>', `${VOCAL_KINDS.join(' | ')}`)
    .option('--source <source>', `${VOCAL_SOURCES.join(' | ')}`)
    .action(async (opts: { kind?: string; source?: string }) => {
      const kind = parseOneOf(opts.kind, '--kind', VOCAL_KINDS);
      const source = parseOneOf(opts.source, '--source', VOCAL_SOURCES);
      const query = new URLSearchParams();
      if (kind) query.set('kind', kind);
      if (source) query.set('source', source);
      const qs = query.toString();
      const response = await publicApiRequest<any>('GET', qs ? `/audio/music/vocals?${qs}` : '/audio/music/vocals');
      printResult(response, () => {
        const rows = Array.isArray(response?.data) ? response.data : [];
        if (rows.length === 0) {
          process.stdout.write(`${dim('No vocals match.')}\n`);
          return;
        }
        printTable(
          rows.map((v: any) => ({
            id: v.id,
            name: v.name,
            kind: v.kind,
            source: v.source,
            genre: v.primary_genre ?? '',
            status: v.status
          })),
          ['id', 'name', 'kind', 'source', 'genre', 'status']
        );
        process.stdout.write(`\n${dim('Use one: genfire generate music "a summer anthem" --vocal <id>')}\n`);
      });
    });

  vocals
    .command('get <vocalId>')
    .description('Show one vocal — poll a custom vocal here until it is completed')
    .action(async (vocalId: string) => {
      const v = await publicApiRequest<any>('GET', `/audio/music/vocals/${encodeURIComponent(vocalId)}`);
      printResult(v, () => {
        process.stdout.write(`${bold(v.name)}  ${dim(v.id)}\n`);
        process.stdout.write(`${dim('Kind:')}     ${v.kind} ${dim(`(${v.source})`)}\n`);
        process.stdout.write(`${dim('Status:')}   ${v.status === 'completed' ? green(v.status) : yellow(String(v.status))}\n`);
        if (v.model) process.stdout.write(`${dim('Model:')}    ${v.model}\n`);
        if (v.failure_reason) process.stdout.write(`${dim('Failed:')}   ${v.failure_reason}\n`);
        if (v.preview_url) process.stdout.write(`${dim('Preview:')}  ${v.preview_url}\n`);
      });
    });

  vocals
    .command('estimate')
    .description('Quote the flat credit cost of training a custom vocal. Free — returns a quote_token for `create --quote`')
    .action(async () => {
      printEstimate(await publicApiRequest('POST', '/audio/music/vocals/estimate-cost', { body: {} }));
    });

  vocals
    .command('create <name>')
    .description('Train a custom VOCAL or STYLE from 1-50 of YOUR OWN tracks (10-600s each). BILLED once (flat) — quote it first with `genfire vocals estimate`. Tracks are copyright-screened upstream; a rejected training is not refunded')
    .requiredOption('-t, --track <urlOrPath>', 'Training track URL, local file or run id (repeatable; local files are uploaded)', collect, [] as string[])
    .requiredOption('--genre <genre>', 'Main genre of the tracks, e.g. pop')
    .option('--kind <kind>', `${VOCAL_KINDS.join(' | ')} (default vocal)`)
    .option('--tag <tag>', 'Descriptive tag (repeatable)', collect, [] as string[])
    .option('--team <teamId>', 'Bill the training to a workspace credit pool instead of your own balance')
    .option('--quote <token>', 'A quote_token from `genfire vocals estimate`')
    .action(async (name: string, opts: VocalCreateFlags & { track: string[] }) => {
      // Validate everything that can fail locally BEFORE uploading.
      buildVocalCreateBody(name, opts.track, opts);
      const body = buildVocalCreateBody(name, await resolveAll(opts.track), opts);
      const run = await publicApiRequest<any>('POST', '/audio/music/vocals', { body, idempotencyKey: randomUUID() });
      printResult(run, () => {
        const vocal = run?.vocal ?? {};
        process.stdout.write(`${green('✓')} Training ${bold(String(vocal.name ?? name))}  ${dim(String(vocal.id ?? ''))} ${dim(`(${vocal.status ?? run?.status ?? 'pending'})`)}\n`);
        if (vocal.id) process.stdout.write(`${dim('Check on it (about 5-10 min):')} genfire vocals get ${vocal.id}\n`);
      });
    });

  vocals
    .command('delete <vocalId>')
    .description('Delete a vocal you own. Not refunded; songs already made with it are unaffected')
    .action(async (vocalId: string) => {
      const result = await publicApiRequest<any>('DELETE', `/audio/music/vocals/${encodeURIComponent(vocalId)}`);
      printResult(result ?? { id: vocalId, deleted: true }, () => {
        process.stdout.write(`${green('✓')} Deleted vocal ${vocalId}\n`);
      });
    });
}

function registerStems(program: Command): void {
  const stems = program
    .command('stems')
    .description('Split a song into stems (vocals + instrumental, or six stems)');

  stems
    .command('estimate')
    .description('Quote a stem separation, per second of the source. Free — returns a quote_token for `split --quote`')
    .option('-d, --duration <seconds>', 'Source length in seconds')
    .option('--audio <urlOrPath>', 'The song (measured server-side) instead of --duration')
    .action(async (opts: { duration?: string; audio?: string }) => {
      if (!opts.duration && !opts.audio) throw new CliError('Pass --duration or --audio.', 'missing_duration');
      let body: Record<string, unknown>;
      if (opts.duration) {
        const seconds = Number(opts.duration);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new CliError(`Invalid --duration: ${opts.duration}`, 'invalid_duration');
        body = { duration_seconds: seconds };
      } else {
        body = { audio_url: (await resolveAll([opts.audio as string]))[0] };
      }
      printEstimate(await publicApiRequest('POST', '/audio/stem-separations/estimate-cost', { body }));
    });

  stems
    .command('split <audio>')
    .description('Separate a song (URL, local file or run id) into stems. BILLED per second of the source')
    .option('--stems <variation>', 'six (vocals, drums, bass, guitar, piano, other — default) | two (vocals + instrumental)')
    .option('--title <title>', 'Title for the saved stems')
    .option('--format <format>', 'Output format')
    .option('-o, --output <dir>', 'Directory to save the stems in; defaults to cwd')
    .option('--no-download', "Don't download the stems; only print the URLs")
    .option('--team <teamId>', 'Bill this run to a workspace credit pool instead of your own balance')
    .option('--quote <token>', 'A quote_token from `genfire stems estimate`')
    .action(async (audio: string, opts: {
      stems?: string; title?: string; format?: string; output?: string; download: boolean;
      team?: string; quote?: string;
    }) => {
      const variation = parseStemVariation(opts.stems);
      const [audioUrl] = await resolveAll([audio]);
      const run = await publicApiRequest<any>('POST', '/audio/stem-separations', {
        body: {
          audio_url: audioUrl,
          ...(variation ? { stem_variation: variation } : {}),
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.format ? { output_format: opts.format } : {}),
          ...(opts.team ? { team_id: opts.team } : {}),
          ...(opts.quote ? { quote_token: opts.quote } : {})
        },
        idempotencyKey: randomUUID()
      });
      const stemRows: Array<{ name?: string; audio_url?: string }> = Array.isArray(run?.output?.stems) ? run.output.stems : [];
      const written = opts.download && stemRows.length > 0
        ? await downloadOutputs(
          stemRows
            .filter((s) => typeof s.audio_url === 'string')
            .map((s, i) => ({ url: s.audio_url as string, suggestedName: `${String(s.name || `stem-${i + 1}`).replace(/[^a-z0-9_-]+/gi, '_')}${extOf(s.audio_url as string)}` })),
          // A directory, never a single file path: there is more than one stem.
          opts.output ?? process.cwd()
        )
        : [];
      printResult(run, () => {
        if (stemRows.length === 0) {
          process.stdout.write(`${dim('Run')} ${run?.id ?? ''} ${dim(`(${run?.status ?? 'unknown'})`)}\n`);
          return;
        }
        printTable(stemRows.map((s) => ({ stem: s.name ?? '', url: s.audio_url ?? '' })), ['stem', 'url']);
        for (const path of written) process.stdout.write(`${green('✓')} ${path}\n`);
      });
    });
}

function extOf(url: string): string {
  try {
    const match = /\.[a-z0-9]{2,5}$/i.exec(new URL(url).pathname);
    return match ? match[0].toLowerCase() : '.mp3';
  } catch {
    return '.mp3';
  }
}

export function registerMusicVocalsCommands(program: Command): void {
  registerVocals(program);
  registerStems(program);
}
