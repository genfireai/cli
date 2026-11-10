import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, dim, green, printResult, printTable, yellow } from '../output.js';

/**
 * Video Layers — `/v1/video-layers` (docs/video-layers/API.md): split a clip
 * (≤ 15 s) into tracked object layers plus depth, then recolor, grade, blur,
 * put tracked text on a surface (live ops — free and instant), make
 * generative edits that change only the chosen layers, and export.
 *
 * Paid calls are QUOTE, THEN CONFIRM: without --yes / --quote-credits /
 * --max-credits, `create`, `edit` and a priced `render` print the price and
 * start nothing.
 *
 * `{ hidden: true }`, like `blade`: the backend flag `videoLayersV1` ships OFF,
 * so every call answers 503 `video_layers_unavailable` until it is turned on.
 * Drop `hidden` at the same release as the MCP VIDEO_LAYERS_TOOLS_ENABLED switch.
 * Every call goes through `publicApiRequest` (the pinned SDK has no Video Layers methods).
 */

interface VLQuote { credits: number; seconds: number; notes: string[] }

interface VLProjectSummary {
  id: string;
  title: string;
  status: string;
  error: string | null;
  duration_sec: number | null;
  size: string | null;
  current_version_id: string | null;
  version_count: number;
  updated_at: string;
}

interface VLJobSummary {
  id: string;
  type: string;
  kind: string | null;
  status: string;
  stage: string | null;
  progress: number | null;
  quote_credits: number;
  charged_credits: number | null;
  error: string | null;
  result_version_id: string | null;
  render: { files: Record<string, string>; proof: { changed_outside_fraction: number | null } } | null;
}

interface VLVersionSummary {
  id: string;
  cause: string;
  duration_sec: number | null;
  preview_url: string | null;
  layers: Array<{ id: string; label: string; kind: string; coverage: number | null; depth: number | null }>;
  planes: Array<{ id: string; label: string; has_plate: boolean }>;
  live_ops: { layers: Record<string, unknown>; texts: Array<{ id: string; plane_id: string; text: string }>; background_blur: unknown; global: unknown };
}

interface VLSummary {
  object: 'video_layers_summary';
  project: VLProjectSummary;
  version: VLVersionSummary | null;
  active_jobs: VLJobSummary[];
}

export const VL_EDIT_KINDS = ['remove', 'replace', 'add', 'relight', 'restyle', 'texture', 'move', 'retime'] as const;
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

const collect = (value: string, previous: string[]) => previous.concat(value.split(',').map((s) => s.trim()).filter(Boolean));
const repeat = (value: string, previous: string[]) => previous.concat(value);
const projectPath = (id: string, suffix = '') => `/video-layers/${encodeURIComponent(id)}${suffix}`;

/** "0.1,0.2" → [0.1, 0.2] with exactly `n` numbers (exported for the tests). */
export function parseNumbers(raw: string | undefined, n: number, what: string): number[] | undefined {
  if (raw === undefined) return undefined;
  const nums = raw.split(',').map((s) => Number(s.trim()));
  if (nums.length !== n || nums.some((x) => !Number.isFinite(x))) {
    throw new CliError(`${what} needs ${n} comma-separated numbers.`, 'invalid_argument');
  }
  return nums;
}

function num(raw: string | undefined, what: string): number | undefined {
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new CliError(`${what} must be a number.`, 'invalid_argument');
  return v;
}

/** "start:end" (seconds) → the trim object (exported for the tests). */
export function parseTrim(raw: string | undefined): { start_sec?: number; end_sec?: number } | undefined {
  if (!raw) return undefined;
  const [a, b] = raw.split(':');
  const start = a?.trim() ? num(a, '--trim start') : undefined;
  const end = b?.trim() ? num(b, '--trim end') : undefined;
  return { ...(start !== undefined ? { start_sec: start } : {}), ...(end !== undefined ? { end_sec: end } : {}) };
}

/** "layer=value" pairs (exported for the tests). The layer may be an id or a label with spaces. */
export function parsePair(raw: string, what: string): [string, string] {
  const at = raw.lastIndexOf('=');
  if (at <= 0 || at === raw.length - 1) throw new CliError(`${what} takes <layer>=<value>, e.g. "red car=#2255ff".`, 'invalid_argument');
  return [raw.slice(0, at).trim(), raw.slice(at + 1).trim()];
}

/** The `changes` list the live-ops flags describe (exported for the tests). */
export function liveOpChangesFromFlags(opts: {
  recolor?: string[]; feather?: string[]; text?: string[]; clear?: string[];
  blur?: string; keepSharp?: string[]; exposure?: string; contrast?: string; saturation?: string; temperature?: string; layer?: string;
  changes?: string;
}): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of opts.recolor ?? []) {
    const [layer, value] = parsePair(r, '--recolor');
    // "#abc" / "#2255ff" / "2255ff" are colours; a bare number ("200") is a hue in degrees.
    const isHex = value.startsWith('#') || /^[0-9a-f]{6}$/i.test(value) || !/^-?\d+(\.\d+)?$/.test(value);
    out.push(isHex ? { op: 'recolor', layer, hex: value.startsWith('#') ? value : `#${value}` } : { op: 'recolor', layer, hue: num(value, '--recolor hue') });
  }
  for (const f of opts.feather ?? []) {
    const [layer, px] = parsePair(f, '--feather');
    out.push({ op: 'feather', layer, px: num(px, '--feather px') });
  }
  const grade: Record<string, unknown> = {};
  for (const k of ['exposure', 'contrast', 'saturation', 'temperature'] as const) {
    const v = num(opts[k], `--${k}`);
    if (v !== undefined) grade[k] = v;
  }
  if (Object.keys(grade).length) out.push({ op: 'grade', ...(opts.layer ? { layer: opts.layer } : {}), ...grade });
  if (opts.blur !== undefined) out.push({ op: 'blur_background', amount: num(opts.blur, '--blur'), ...(opts.keepSharp?.length ? { keep_sharp: opts.keepSharp } : {}) });
  for (const t of opts.text ?? []) {
    const at = t.indexOf('=');
    if (at <= 0) throw new CliError('--text takes <surface>=<text>, e.g. "shop sign=OPEN".', 'invalid_argument');
    out.push({ op: 'text', plane: t.slice(0, at).trim(), text: t.slice(at + 1) });
  }
  for (const c of opts.clear ?? []) out.push(c === 'all' ? { op: 'clear', what: 'all' } : { op: 'clear', layer: c });
  if (opts.changes) {
    let parsed: unknown;
    try { parsed = JSON.parse(opts.changes); } catch { throw new CliError('--changes must be JSON: a change object or a list of them.', 'invalid_argument'); }
    out.push(...(Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>);
  }
  return out;
}

/** The edit body the flags describe (exported for the tests). */
export function editBodyFromFlags(kind: string, opts: Record<string, any>): Record<string, unknown> {
  if (!(VL_EDIT_KINDS as readonly string[]).includes(kind)) {
    throw new CliError(`kind must be one of: ${VL_EDIT_KINDS.join(', ')}.`, 'invalid_argument');
  }
  const layers: string[] = opts.layer ?? [];
  const single = kind === 'replace' || kind === 'texture' || kind === 'move' || kind === 'retime';
  const body: Record<string, unknown> = {
    kind,
    ...(layers.length ? (single ? { layer: layers[0] } : { layers }) : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.reference ? { reference_image_url: opts.reference } : {}),
    ...(opts.box ? { box: parseNumbers(opts.box, 4, '--box') } : {}),
    ...(opts.color ? { color: opts.color } : {}),
    ...(opts.attribute ? { attribute: opts.attribute } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.versionId ? { version_id: opts.versionId } : {}),
  };
  for (const k of ['azimuth', 'elevation', 'intensity', 'softness', 'amount', 'dx', 'dy', 'scale', 'speed'] as const) {
    const v = num(opts[k], `--${k}`);
    if (v !== undefined) body[k] = v;
  }
  return body;
}

function printQuote(q: VLQuote, what: string, hint: string): void {
  process.stdout.write(`${bold(`${q.credits} credits`)}  ${dim(`${what}, ${q.seconds} s billed`)}\n`);
  for (const n of q.notes ?? []) process.stdout.write(`${dim('·')} ${n}\n`);
  process.stdout.write(`${yellow('Nothing started.')} ${hint}\n`);
}

function printJob(j: VLJobSummary): void {
  const pct = j.progress !== null && j.progress !== undefined ? ` ${Math.round(j.progress * 100)}%` : '';
  process.stdout.write(`${bold(j.id)}  ${j.type}${j.kind ? `/${j.kind}` : ''}  ${j.status}${pct}${j.stage ? dim(` (${j.stage})`) : ''}\n`);
  process.stdout.write(`${dim('Credits:')}  ${j.charged_credits ?? j.quote_credits}${j.charged_credits === null ? dim(' (held)') : ''}\n`);
  if (j.result_version_id) process.stdout.write(`${dim('Version:')}  ${j.result_version_id}\n`);
  for (const [output, url] of Object.entries(j.render?.files ?? {})) process.stdout.write(`${dim(`${output}:`)} ${url}\n`);
  if (j.render?.proof?.changed_outside_fraction !== null && j.render?.proof?.changed_outside_fraction !== undefined) {
    process.stdout.write(`${dim('Proof:')}    ${(j.render.proof.changed_outside_fraction * 100).toFixed(4)}% of pixels outside the edited layers changed\n`);
  }
  if (j.error) process.stdout.write(`${yellow('error')} ${j.error}\n`);
}

function printSummary(s: VLSummary): void {
  const p = s.project;
  process.stdout.write(`${bold(p.title || p.id)}  ${dim(p.id)}  ${p.status}${p.duration_sec ? dim(`  ${p.duration_sec}s ${p.size ?? ''}`) : ''}\n`);
  if (p.error) process.stdout.write(`${yellow('error')} ${p.error}\n`);
  const v = s.version;
  if (v) {
    process.stdout.write(`${dim('Version:')}  ${v.id} ${dim(`(${v.cause})`)}${v.preview_url ? `  ${v.preview_url}` : ''}\n`);
    printTable(v.layers.map((l) => ({ layer: l.id, label: l.label, kind: l.kind, coverage: l.coverage ?? '', depth: l.depth ?? '' })), ['layer', 'label', 'kind', 'coverage', 'depth']);
    if (v.planes.length) process.stdout.write(`${dim('Surfaces:')} ${v.planes.map((pl) => `${pl.id} "${pl.label}"`).join(', ')}\n`);
    const looks = Object.keys(v.live_ops.layers).length + v.live_ops.texts.length + (v.live_ops.background_blur ? 1 : 0) + (v.live_ops.global ? 1 : 0);
    if (looks) process.stdout.write(`${dim('Live ops:')} ${JSON.stringify(v.live_ops)}\n`);
  }
  for (const j of s.active_jobs) printJob(j);
}

async function pollJob(projectId: string, jobId: string, timeoutSec: number, intervalMs: number): Promise<VLJobSummary> {
  const deadline = Date.now() + timeoutSec * 1000;
  let job = await publicApiRequest<VLJobSummary>('GET', projectPath(projectId, `/jobs/${encodeURIComponent(jobId)}?view=summary`));
  while (!TERMINAL.has(job.status) && Date.now() + intervalMs <= deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    job = await publicApiRequest<VLJobSummary>('GET', projectPath(projectId, `/jobs/${encodeURIComponent(jobId)}?view=summary`));
  }
  return job;
}

interface PaidOpts { yes?: boolean; quoteCredits?: string; maxCredits?: string; key?: string; wait?: boolean; timeout?: string }

/**
 * QUOTE, THEN CONFIRM. --quote-credits / --max-credits start directly (the API
 * re-quotes); --yes prices first and starts at that price; neither prints the
 * quote and starts nothing — unless the call is free.
 */
async function quoteThenStart<T>(quotePath: string, startPath: string, body: Record<string, unknown>, opts: PaidOpts, what: string, rerun: string): Promise<T | null> {
  const quoteCredits = num(opts.quoteCredits, '--quote-credits');
  const maxCredits = num(opts.maxCredits, '--max-credits');
  if (quoteCredits !== undefined) body.quote_credits = quoteCredits;
  else if (maxCredits !== undefined) body.max_credits = maxCredits;
  else {
    const quote = await publicApiRequest<VLQuote>('POST', quotePath, { body });
    if (quote.credits > 0 && !opts.yes) {
      printResult({ status: 'quote', quote }, () => printQuote(quote, what, `Re-run with --yes (or --quote-credits ${quote.credits}) to start: ${rerun}`));
      return null;
    }
    body.quote_credits = quote.credits;
  }
  return publicApiRequest<T>('POST', startPath, { body, idempotencyKey: opts.key || randomUUID() });
}

async function finishJob(projectId: string, job: VLJobSummary | { id: string }, opts: PaidOpts, intervalMs: number, prefix: string): Promise<void> {
  if (opts.wait) {
    const done = await pollJob(projectId, job.id, num(opts.timeout, '--timeout') ?? 600, intervalMs);
    printResult(done, () => printJob(done));
    return;
  }
  printResult({ job }, () => {
    process.stdout.write(`${green('✓')} ${prefix} ${bold(job.id)}\n`);
    process.stdout.write(`${dim(`Follow it: genfire video-layers job ${projectId} ${job.id} --wait`)}\n`);
  });
}

const paidOptions = (cmd: Command, priced: boolean) => {
  if (priced) {
    cmd
      .option('-y, --yes', 'Accept the quoted price and start')
      .option('--quote-credits <n>', 'Start at this exact quote (the API re-checks it)')
      .option('--max-credits <n>', 'Start only if the price is at most this');
  }
  return cmd
    .option('--key <key>', 'Idempotency key (a retry with the same key returns the same job)')
    .option('-w, --wait', 'Wait for the job to finish')
    .option('--timeout <seconds>', 'With --wait: give up waiting after this long (default 600)');
};

export function registerVideoLayersCommand(program: Command, deps: { pollMs?: number } = {}): void {
  const pollMs = deps.pollMs ?? 3000;
  const vl = program
    .command('video-layers', { hidden: true })
    .alias('vl')
    .description('Video Layers: split a clip into tracked layers + depth, then recolor, edit and export each object');

  vl.command('flags')
    .description('Is Video Layers on for this account')
    .action(async () => {
      const f = await publicApiRequest<{ mode: string; enabled: boolean; liveGenerative: boolean }>('GET', '/video-layers/flags');
      printResult(f, () => process.stdout.write(`${f.enabled ? green('enabled') : yellow('not enabled')}  ${dim(`mode ${f.mode}`)}\n`));
    });

  vl.command('list')
    .description('List your Video Layers projects, newest first')
    .action(async () => {
      const list = await publicApiRequest<{ object: 'list'; data: VLProjectSummary[] }>('GET', '/video-layers?view=summary');
      printResult(list, () => {
        if (list.data.length === 0) {
          process.stdout.write(`${dim('No projects yet. Start one: genfire video-layers create <video-url>')}\n`);
          return;
        }
        printTable(list.data.map((p) => ({
          project: p.id, title: p.title, status: p.status, seconds: p.duration_sec ?? '', versions: p.version_count, updated: p.updated_at?.slice(0, 16).replace('T', ' '),
        })), ['project', 'title', 'status', 'seconds', 'versions', 'updated']);
      });
    });

  paidOptions(
    vl.command('create <sourceUrl>')
      .description('Split a clip (≤ 15 s after trim) into tracked layers + depth (paid: quotes first)')
      .option('-t, --title <title>', 'Project title')
      .option('--trim <start:end>', 'Seconds to keep, e.g. 2:14 (needed for clips over 15 s)')
      .option('--prompt <object>', 'An object that must become a layer (repeatable)', repeat, [] as string[]),
    true,
  ).action(async (sourceUrl: string, opts: PaidOpts & { title?: string; trim?: string; prompt: string[] }) => {
    const trim = parseTrim(opts.trim);
    const body: Record<string, unknown> = {
      source_url: sourceUrl,
      ...(opts.title ? { title: opts.title } : {}),
      ...(trim ? { trim } : {}),
      ...(opts.prompt.length ? { prompts: opts.prompt } : {}),
    };
    const out = await quoteThenStart<{ project: { id: string; title: string }; job: VLJobSummary }>(
      '/video-layers/quote/split', '/video-layers', body, opts, 'split', `genfire video-layers create ${sourceUrl} --yes`,
    );
    if (!out) return;
    await finishJob(out.project.id, out.job, opts, pollMs, `Splitting ${bold(out.project.id)} — job`);
  });

  vl.command('get <projectId>')
    .description('Show a project: layers, tracked surfaces, live ops, running jobs')
    .option('--full', 'The whole project document (with per-frame tracking data)')
    .action(async (projectId: string, opts: { full?: boolean }) => {
      if (opts.full) {
        const bundle = await publicApiRequest<unknown>('GET', projectPath(projectId));
        printResult(bundle, () => process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`));
        return;
      }
      const s = await publicApiRequest<VLSummary>('GET', projectPath(projectId, '?view=summary'));
      printResult(s, () => printSummary(s));
    });

  vl.command('version <projectId> <versionId>')
    .description('Show one version')
    .option('--full', 'The whole version document')
    .action(async (projectId: string, versionId: string, opts: { full?: boolean }) => {
      const v = await publicApiRequest<unknown>('GET', projectPath(projectId, `/versions/${encodeURIComponent(versionId)}${opts.full ? '' : '?view=summary'}`));
      printResult(v, () => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`));
    });

  vl.command('mattes <projectId> <versionId>')
    .description('Print the URL of a version\'s per-frame mattes file')
    .action(async (projectId: string, versionId: string) => {
      const m = await publicApiRequest<{ url: string; format: string }>('GET', projectPath(projectId, `/versions/${encodeURIComponent(versionId)}/mattes`));
      printResult(m, () => process.stdout.write(`${m.url}\n`));
    });

  vl.command('live-ops <projectId>')
    .description('Free, instant looks: recolor, grade, feather, blur the background, tracked text')
    .option('--recolor <layer=#hex>', 'Recolor a layer (hex, or a hue 0–360); repeatable', repeat, [] as string[])
    .option('--feather <layer=px>', 'Soften a layer\'s edge; repeatable', repeat, [] as string[])
    .option('--exposure <n>', 'Grade: exposure (-1..1)')
    .option('--contrast <n>', 'Grade: contrast (-1..1)')
    .option('--saturation <n>', 'Grade: saturation (-1..1)')
    .option('--temperature <n>', 'Grade: temperature (-1..1)')
    .option('--layer <layer>', 'Grade this layer instead of the whole frame')
    .option('--blur <amount>', 'Blur the background (0 = off)')
    .option('--keep-sharp <layer>', 'With --blur: keep this layer sharp (repeatable, or comma-separated)', collect, [] as string[])
    .option('--text <surface=text>', 'Text on a tracked surface; repeatable', repeat, [] as string[])
    .option('--clear <layer|all>', 'Clear a layer\'s looks, or everything; repeatable', repeat, [] as string[])
    .option('--changes <json>', 'Declarative changes as JSON (see docs/video-layers/API.md)')
    .option('-f, --file <path>', 'A JSON file: {"changes": [...]} or a whole live_ops document')
    .option('--version-id <versionId>', 'Version to change (default: current)')
    .action(async (projectId: string, opts: Record<string, any>) => {
      let body: Record<string, unknown>;
      if (opts.file) {
        let doc: any;
        try { doc = JSON.parse(readFileSync(opts.file, 'utf8')); } catch { throw new CliError(`Could not read JSON from ${opts.file}.`, 'invalid_argument'); }
        body = doc && typeof doc === 'object' && ('changes' in doc || 'live_ops' in doc) ? doc : { live_ops: doc };
      } else {
        const changes = liveOpChangesFromFlags({ ...opts, keepSharp: opts.keepSharp });
        if (!changes.length) throw new CliError('Nothing to change. Pass --recolor, --blur, --text, --clear, --changes or --file.', 'invalid_argument');
        body = { changes };
      }
      if (opts.versionId) body.version_id = opts.versionId;
      const out = await publicApiRequest<{ version: VLVersionSummary; notes: string[] }>('PATCH', projectPath(projectId, '/live-ops?view=summary'), { body });
      printResult(out, () => {
        process.stdout.write(`${green('✓')} Saved on ${bold(out.version.id)}${out.version.preview_url ? `  ${out.version.preview_url}` : ''}\n`);
        for (const n of out.notes ?? []) process.stdout.write(`${yellow('note')} ${n}\n`);
      });
    });

  paidOptions(
    vl.command('edit <projectId> <kind>')
      .description(`Generative edit inside chosen layers only (${VL_EDIT_KINDS.join(', ')}; paid: quotes first)`)
      .option('-l, --layer <layer>', 'Layer id or label (repeatable)', repeat, [] as string[])
      .option('-p, --prompt <text>', 'What to put there / the style')
      .option('--reference <url>', 'Reference image (replace / add)')
      .option('--box <x0,y0,x1,y1>', 'Where to add (0..1)')
      .option('--azimuth <deg>', 'Relight: light direction')
      .option('--elevation <deg>', 'Relight: light height')
      .option('--color <hex>', 'Relight: light color')
      .option('--intensity <n>', 'Relight: 0..2')
      .option('--softness <n>', 'Relight: 0..1')
      .option('--attribute <text>', 'Texture: what to change, e.g. "wet"')
      .option('--amount <n>', 'Texture: 0..1')
      .option('--dx <n>', 'Move: fraction of the frame width')
      .option('--dy <n>', 'Move: fraction of the frame height')
      .option('--scale <n>', 'Move: scale')
      .option('--speed <n>', 'Retime: e.g. 0.5')
      .option('--model <omni|kling>', 'Restyle engine')
      .option('--version-id <versionId>', 'Version to edit (default: current)'),
    true,
  ).action(async (projectId: string, kind: string, opts: PaidOpts & Record<string, any>) => {
    const body = editBodyFromFlags(kind, opts);
    const out = await quoteThenStart<{ job: VLJobSummary }>(
      projectPath(projectId, '/quote/edit'), projectPath(projectId, '/edits'), body, opts, `${kind} edit`, `the same command plus --yes`,
    );
    if (!out) return;
    await finishJob(projectId, out.job, opts, pollMs, 'Editing — job');
  });

  paidOptions(
    vl.command('segment <projectId>')
      .description('Add a layer (by prompt, point or box) or refine one (paid per second)')
      .option('-p, --prompt <text>', 'What to pull out')
      .option('--frame <n>', 'Frame the point / box is on')
      .option('--point <x,y>', 'A point on the object (0..1)')
      .option('--box <x0,y0,x1,y1>', 'A box around the object (0..1)')
      .option('-l, --layer <layer>', 'Refine this layer instead')
      .option('--version-id <versionId>', 'Version (default: current)'),
    false,
  ).action(async (projectId: string, opts: PaidOpts & Record<string, any>) => {
    const frame = num(opts.frame, '--frame');
    const body: Record<string, unknown> = {
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(frame !== undefined ? { frame_index: frame } : {}),
      ...(opts.point ? { point: parseNumbers(opts.point, 2, '--point') } : {}),
      ...(opts.box ? { box: parseNumbers(opts.box, 4, '--box') } : {}),
      ...(opts.layer ? { layer: opts.layer } : {}),
      ...(opts.versionId ? { version_id: opts.versionId } : {}),
    };
    const out = await publicApiRequest<{ job: VLJobSummary }>('POST', projectPath(projectId, '/segment'), { body, idempotencyKey: opts.key || randomUUID() });
    await finishJob(projectId, out.job, opts, pollMs, 'Segmenting — job');
  });

  paidOptions(
    vl.command('track <projectId>')
      .description('Track a flat surface for text from its four corners (paid, small flat price)')
      .requiredOption('--quad <x,y,x,y,x,y,x,y>', 'Corners TL, TR, BR, BL (0..1)')
      .option('--frame <n>', 'Frame the corners are on (default 0)')
      .option('--label <text>', 'A name for the surface')
      .option('--plate', 'Also clean existing text off it (costs more)')
      .option('--version-id <versionId>', 'Version (default: current)'),
    false,
  ).action(async (projectId: string, opts: PaidOpts & Record<string, any>) => {
    const flat = parseNumbers(opts.quad, 8, '--quad')!;
    const frame = num(opts.frame, '--frame');
    const body: Record<string, unknown> = {
      quad: [[flat[0], flat[1]], [flat[2], flat[3]], [flat[4], flat[5]], [flat[6], flat[7]]],
      ...(frame !== undefined ? { frame_index: frame } : {}),
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.plate ? { make_plate: true } : {}),
      ...(opts.versionId ? { version_id: opts.versionId } : {}),
    };
    const out = await publicApiRequest<{ job: VLJobSummary }>('POST', projectPath(projectId, '/track'), { body, idempotencyKey: opts.key || randomUUID() });
    await finishJob(projectId, out.job, opts, pollMs, 'Tracking — job');
  });

  paidOptions(
    vl.command('render <projectId>')
      .description('Export with live ops: mp4 (free), layers_prores4444, mattes_png, depth_png16, ae_corner_pins, hdr10')
      .option('-o, --output <output>', 'An output (repeatable, or comma-separated; default mp4)', collect, [] as string[])
      .option('--version-id <versionId>', 'Version (default: current)'),
    true,
  ).action(async (projectId: string, opts: PaidOpts & { output: string[]; versionId?: string }) => {
    const body: Record<string, unknown> = {
      ...(opts.output.length ? { outputs: opts.output } : {}),
      ...(opts.versionId ? { version_id: opts.versionId } : {}),
    };
    const out = await quoteThenStart<{ job: VLJobSummary }>(
      projectPath(projectId, '/quote/render'), projectPath(projectId, '/render'), body, opts, 'export', 'the same command plus --yes',
    );
    if (!out) return;
    await finishJob(projectId, out.job, opts, pollMs, 'Rendering — job');
  });

  vl.command('job <projectId> <jobId>')
    .description('Show a job (status, progress, new version, render files)')
    .option('-w, --wait', 'Wait for it to finish')
    .option('--timeout <seconds>', 'With --wait: give up waiting after this long (default 600)')
    .action(async (projectId: string, jobId: string, opts: { wait?: boolean; timeout?: string }) => {
      const job = opts.wait
        ? await pollJob(projectId, jobId, num(opts.timeout, '--timeout') ?? 600, pollMs)
        : await publicApiRequest<VLJobSummary>('GET', projectPath(projectId, `/jobs/${encodeURIComponent(jobId)}?view=summary`));
      printResult(job, () => printJob(job));
    });

  vl.command('cancel <projectId> <jobId>')
    .description('Cancel a queued or running job (credits are released if it had not started work)')
    .action(async (projectId: string, jobId: string) => {
      const job = await publicApiRequest<VLJobSummary>('POST', projectPath(projectId, `/jobs/${encodeURIComponent(jobId)}/cancel?view=summary`));
      printResult(job, () => printJob(job));
    });

  vl.command('undo <projectId>')
    .description('Step back to the previous version')
    .action(async (projectId: string) => {
      const s = await publicApiRequest<VLSummary>('POST', projectPath(projectId, '/undo?view=summary'));
      printResult(s, () => printSummary(s));
    });

  vl.command('rename <projectId> <title>')
    .description('Rename a project')
    .action(async (projectId: string, title: string) => {
      const p = await publicApiRequest<VLProjectSummary>('PATCH', projectPath(projectId, '?view=summary'), { body: { title } });
      printResult(p, () => process.stdout.write(`${green('✓')} ${bold(p.id)} is now "${p.title}"\n`));
    });

  vl.command('delete <projectId>')
    .description('Delete a project and its files')
    .option('-y, --yes', 'Confirm the delete')
    .action(async (projectId: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        throw new CliError(`This permanently deletes ${projectId} and its files. Re-run with --yes to confirm.`, 'confirmation_required');
      }
      const out = await publicApiRequest<{ ok: boolean; id: string }>('DELETE', projectPath(projectId));
      printResult(out, () => process.stdout.write(`${green('✓')} Deleted ${bold(projectId)}\n`));
    });
}
