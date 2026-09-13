import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient, publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, printResult, printTable } from '../output.js';
import {
  downloadOutputs,
  extractOutputUrls,
  reportRunCompletion,
  waitForRun
} from '../runHelpers.js';

/**
 * `genfire timeline` — the persisted, re-renderable edit.
 *
 * `genfire generate` and `videos.compose` assemble clips end to end. Neither
 * can say "this logo sits at 62% width, 8% height, at 40% scale, rotated 3°,
 * from 2.0s to 6.5s, on top of the footage" — nothing in their vocabulary puts
 * two things on screen at once. A timeline is that edit, addressable: store it,
 * read it, patch it, render it again.
 *
 * Every call here goes through `publicApiRequest` rather than the SDK client:
 * the CLI pins @genfire/sdk 0.23.0 and these routes are newer than it. The SDK
 * SOURCE in this repo types all of them (createTimeline / getTimeline /
 * updateTimeline / renderTimeline / listTimelineRenders), so this file
 * collapses onto typed methods at the next SDK cut.
 */

/** One clip of the manifest. camelCase — the manifest is the editor's own shape. */
interface TimelineClip {
  id: string;
  type: 'video' | 'image' | 'text' | 'audio';
  sourceId?: string;
  startTime: number;
  duration: number;
  sourceStartTime?: number;
  volume?: number;
  muted?: boolean;
  trackIndex?: number;
  layout?: { x: number; y: number; scale: number; rotation?: number };
  textContent?: string;
  textStyle?: Record<string, unknown>;
}

interface TimelineGraphics {
  layers: Array<Record<string, unknown>>;
  aboveCaptions?: boolean;
}

interface TimelineManifest {
  /** 1, or 2 once `graphics` is present. Nothing else separates them. */
  version: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  clips: TimelineClip[];
  sources: Array<{ id: string; kind: string; ref: string; url: string; measured?: Record<string, unknown> }>;
  graphics?: TimelineGraphics;
}

interface Timeline {
  id: string;
  object: 'timeline';
  rev: number;
  manifest_hash: string;
  title: string | null;
  project_id: string | null;
  manifest: TimelineManifest;
  created_at: string;
  updated_at: string;
}

interface QueuedRun {
  id: string;
  status: string;
  capability: string;
  output?: Record<string, unknown> | null;
}

/**
 * Read a manifest from a file, or `-` for stdin.
 *
 * A timeline is authored, not flag-driven: sixty clips with per-clip layout do
 * not fit on a command line, and `timeline get > f.json`, edit, `timeline
 * update -f f.json` is the loop this command exists for.
 */
async function readManifestFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    try {
      raw = await readFile(path, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') throw new CliError(`Manifest file not found: ${path}`, 'manifest_not_found');
      throw err;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`${path} is not valid JSON: ${(err as Error).message}`, 'invalid_manifest');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`${path} must contain a manifest object at the top level.`, 'invalid_manifest');
  }
  const manifest = parsed as Record<string, unknown>;
  // A `timeline get` result nests the manifest under `manifest`; accept that
  // shape directly so the read → edit → write loop needs no jq step.
  const inner = manifest.manifest;
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && Array.isArray((inner as any).clips)) {
    return inner as Record<string, unknown>;
  }
  if (!Array.isArray(manifest.clips)) {
    throw new CliError(`${path} must carry a clips[] array (or a full \`timeline get\` result).`, 'invalid_manifest');
  }
  return manifest;
}

/**
 * Read a `graphics` block from a file, or `-` for stdin.
 *
 * A manifest file may simply carry `graphics` itself — `timeline get
 * --manifest > edit.json` round-trips it like everything else, and that is the
 * loop to stay in once an overlay exists. `--graphics` is for the other shape:
 * the cut and the overlay authored as two files, so a designer can iterate on
 * the layers without ever opening the clip list. Accepts either the block
 * (`{ layers: [...] }`) or a bare `[ ...layers ]`.
 */
async function readGraphicsFile(path: string): Promise<TimelineGraphics> {
  let raw: string;
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    try {
      raw = await readFile(path, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') throw new CliError(`Graphics file not found: ${path}`, 'graphics_not_found');
      throw err;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`${path} is not valid JSON: ${(err as Error).message}`, 'invalid_graphics');
  }
  if (Array.isArray(parsed)) return { layers: parsed as Array<Record<string, unknown>> };
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).layers)) {
    return parsed as TimelineGraphics;
  }
  throw new CliError(
    `${path} must be { "layers": [...] } or a bare array of layers.`,
    'invalid_graphics'
  );
}

function printTimeline(timeline: Timeline): void {
  printResult(timeline, () => {
    process.stdout.write(`${bold(timeline.id)} ${dim(`rev ${timeline.rev}`)}\n`);
    if (timeline.title) process.stdout.write(`${dim('Title:')}    ${timeline.title}\n`);
    const m = timeline.manifest;
    process.stdout.write(
      `${dim('Frame:')}    ${m.width}x${m.height} @ ${m.fps}fps  ${dim(`${m.duration}s`)}\n`
    );
    process.stdout.write(`${dim('Clips:')}    ${m.clips.length}  ${dim(`${m.sources.length} sources`)}\n`);
    if (m.graphics?.layers?.length) {
      process.stdout.write(
        `${dim('Graphics:')} ${m.graphics.layers.length} layers  ` +
        `${dim(`v${m.version}${m.graphics.aboveCaptions ? ', above captions' : ''}`)}\n`
      );
    }
    if (timeline.project_id) process.stdout.write(`${dim('Project:')}  ${timeline.project_id}\n`);
    process.stdout.write(`${dim('Hash:')}     ${timeline.manifest_hash.slice(0, 16)}…\n`);
    process.stdout.write(
      `\n${dim(`Render it: genfire timeline render ${timeline.id}`)}\n`
    );
  });
}

function parseWaitMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new CliError(`Invalid --wait-timeout: ${value}`, 'invalid_duration');
  }
  return Math.round(minutes * 60 * 1000);
}

export function registerTimelineCommands(program: Command): void {
  const timeline = program
    .command('timeline')
    .description('Store, edit and render a timeline — an edit with exact overlay placement, unlike a straight compose');

  // ---- create ----
  timeline
    .command('create')
    .description('Store a manifest as a new timeline (free). Sources are probed up front, so a bad one fails here, not mid-render.')
    .requiredOption(
      '-f, --file <pathOrDash>',
      'JSON manifest: { duration, width, height, fps?, clips[], sources[], graphics? }. Use - to read stdin.'
    )
    .option(
      '-g, --graphics <pathOrDash>',
      'Keyframed OVERLAY layers as their own JSON file — { "layers": [...] } or a bare array. Stores the manifest at version 2. Wins over any `graphics` already in --file. Use - for stdin.'
    )
    .option('-t, --title <title>', 'Name this edit in your library')
    .option('--team <teamId>', 'Bill later renders to a workspace credit pool')
    .option('--project <projectId>', 'File renders of this timeline into a project')
    .action(async (opts: { file: string; graphics?: string; title?: string; team?: string; project?: string }) => {
      const manifest = await readManifestFile(opts.file);
      const graphics = opts.graphics ? await readGraphicsFile(opts.graphics) : undefined;
      const created = await publicApiRequest<Timeline>('POST', '/videos/timelines', {
        body: {
          ...manifest,
          ...(graphics ? { graphics } : {}),
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.team ? { team_id: opts.team } : {}),
          ...(opts.project ? { project_id: opts.project } : {})
        }
      });
      printTimeline(created);
    });

  // ---- get ----
  timeline
    .command('get <timelineId>')
    .description('Read a timeline and its current rev. Pipe it to a file, edit, then `timeline update`.')
    .option('--manifest', 'Print only the manifest object (what `timeline update -f` wants)')
    .action(async (timelineId: string, opts: { manifest?: boolean }) => {
      const found = await publicApiRequest<Timeline>('GET', `/videos/timelines/${encodeURIComponent(timelineId)}`);
      if (opts.manifest) {
        process.stdout.write(`${JSON.stringify(found.manifest, null, 2)}\n`);
        return;
      }
      printTimeline(found);
    });

  // ---- update ----
  timeline
    .command('update <timelineId>')
    .description('Replace a timeline\'s manifest. WHOLE-manifest replace, not a merge — send every clip you want to keep.')
    .requiredOption('-f, --file <pathOrDash>', 'The edited manifest JSON (or a full `timeline get` result). Use - for stdin.')
    .option(
      '-r, --rev <n>',
      'The rev you are editing. Omit to re-read it first — but that re-read is a race, so pass the rev you actually edited when it matters.'
    )
    .option(
      '-g, --graphics <pathOrDash>',
      'Replace the overlay layers from their own JSON file. Wins over any `graphics` in --file. NOTE: this is a whole-manifest replace, so a manifest carrying no graphics and no --graphics DELETES the overlay and returns the timeline to version 1.'
    )
    .option('-t, --title <title>', 'Rename the edit')
    .action(async (timelineId: string, opts: { file: string; graphics?: string; rev?: string; title?: string }) => {
      const manifest = await readManifestFile(opts.file);
      const graphics = opts.graphics ? await readGraphicsFile(opts.graphics) : undefined;
      let rev: number;
      if (opts.rev !== undefined) {
        rev = Number(opts.rev);
        if (!Number.isInteger(rev) || rev < 1) {
          throw new CliError('--rev must be a positive integer', 'invalid_rev');
        }
      } else {
        const current = await publicApiRequest<Timeline>(
          'GET',
          `/videos/timelines/${encodeURIComponent(timelineId)}`
        );
        rev = current.rev;
      }
      const updated = await publicApiRequest<Timeline>(
        'PATCH',
        `/videos/timelines/${encodeURIComponent(timelineId)}`,
        {
          body: {
            ...manifest,
            ...(graphics ? { graphics } : {}),
            rev,
            ...(opts.title ? { title: opts.title } : {})
          }
        }
      );
      printTimeline(updated);
    });

  // ---- render ----
  timeline
    .command('render <timelineId>')
    .description('Render a timeline. Free. Previews are 480p on the short edge and cached by content, so re-viewing a revision costs one pass.')
    .option('--final', 'Render at the stated frame instead of a preview')
    .option('-r, --rev <n>', 'Guard: render only if the timeline is still at this rev (else 409)')
    .option('-o, --output <path>', 'Where to save the rendered video')
    .option('--no-download', "Don't download the output; only print the run")
    .option('--no-wait', 'Return the queued run immediately instead of polling')
    .option('--wait-timeout <minutes>', 'Maximum minutes to wait', '30')
    .action(async (timelineId: string, opts: {
      final?: boolean; rev?: string; output?: string; download: boolean; wait: boolean; waitTimeout: string;
    }) => {
      const mode = opts.final ? 'final' : 'preview';
      const run = await publicApiRequest<QueuedRun>(
        'POST',
        `/videos/timelines/${encodeURIComponent(timelineId)}/renders`,
        {
          body: {
            mode,
            ...(opts.rev !== undefined ? { rev: Number(opts.rev) } : {})
          },
          // The route is gated by `requireIdempotencyKey`, which reads the
          // HEADER — the same `idempotency_key` spelled into the body was
          // simply ignored and every render 400s `idempotency_key_required`.
          // Renders dedupe on the REVISION, not the key, so a fresh key per
          // invocation is right: an unchanged rev collapses onto the earlier
          // run server-side anyway.
          idempotencyKey: randomUUID()
        }
      );

      if (!opts.wait) {
        printResult(run, () => {
          process.stderr.write(`${dim(`${mode} render queued:`)} ${run.id} ${dim(`(${run.status})`)}\n`);
          process.stderr.write(`${dim('Re-check with:')} genfire runs get ${run.id}\n`);
        });
        return;
      }

      const client = await createClient();
      process.stderr.write(`${dim(`Polling ${mode} render ${run.id}...`)}\n`);
      const finished = await waitForRun(client, run.id, {
        timeoutMs: parseWaitMinutes(opts.waitTimeout),
        onTick: (current, elapsed) => {
          if (current.status !== 'completed' && current.status !== 'failed') {
            process.stderr.write(`${dim(`  status=${current.status} elapsed=${Math.round(elapsed / 1000)}s\r`)}`);
          }
        }
      });
      process.stderr.write('\n');

      // A cached preview comes back completed immediately — worth saying, so a
      // user does not read an instant result as a failure to re-render.
      if ((finished.output as any)?.cached) {
        process.stderr.write(`${dim('Served from cache — this revision was already rendered.')}\n`);
      }

      if (finished.status !== 'completed' || !opts.download) {
        reportRunCompletion(finished, []);
        return;
      }
      const outputs = extractOutputUrls(finished, `timeline-${mode}`);
      const written = await downloadOutputs(outputs, opts.output);
      reportRunCompletion(finished, written);
    });

  // ---- renders ----
  timeline
    .command('renders <timelineId>')
    .description('List every render of a timeline, newest first, with the rev each came from')
    .option('-l, --limit <n>', 'Max renders to return', '25')
    .action(async (timelineId: string, opts: { limit: string }) => {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError('--limit must be an integer 1-100', 'invalid_limit');
      }
      const response = await publicApiRequest<{ object: 'list'; data: any[] }>(
        'GET',
        `/videos/timelines/${encodeURIComponent(timelineId)}/renders?limit=${limit}`
      );
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('This timeline has not been rendered yet.')}\n`);
          return;
        }
        printTable(
          response.data.map((run) => ({
            id: run.id,
            status: run.status,
            mode: run.input_summary?.mode ?? '',
            rev: run.input_summary?.rev ?? '',
            created: String(run.created_at || '').replace('T', ' ').slice(0, 19)
          })),
          ['id', 'status', 'mode', 'rev', 'created']
        );
        process.stdout.write(`\n${dim(`Fetch one with: genfire runs output ${response.data[0].id}`)}\n`);
      });
    });

  // A deliberate omission worth naming in --help: there is no `timeline list`
  // and no `timeline delete`. Neither route exists on /v1 yet; adding a client
  // command for them would only produce a 404.
  timeline.addHelpText(
    'after',
    `\n${dim('Author a manifest, then:')}\n` +
    `  genfire timeline create -f edit.json -t "Launch cut"\n` +
    `  genfire timeline create -f edit.json -g overlay.json ${cyan('# adds keyframed graphics (v2)')}\n` +
    `  genfire timeline render tl_… ${cyan('# 480p proxy, cached')}\n` +
    `  genfire timeline get tl_… --manifest > edit.json ${cyan('# edit, then:')}\n` +
    `  genfire timeline update tl_… -f edit.json\n` +
    `  genfire timeline render tl_… --final\n`
  );
}
