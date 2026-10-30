import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publicApiRequest } from '../client.js';
import { bold, dim, green, printResult, printTable, yellow } from '../output.js';

/**
 * Blade — `/v1/blade` (docs/blade README, Contract 2): reference edits. A
 * session wraps one edit: start it (a preset or your own reference plus your
 * photos/clips), record the quote the user agreed to, and finish it with the
 * final video, its timeline and every run it started.
 *
 * `{ hidden: true }`, like `runtime`: the backend flag `bladeV1` ships OFF, so
 * every one of these answers 503 `blade_unavailable` until it is turned on.
 * Fully callable for internal testing; drop the flag at the same release as
 * the MCP BLADE_TOOLS_ENABLED switch.
 *
 * The pinned SDK has no Blade methods yet, so every call goes through
 * `publicApiRequest`.
 */

interface BladePreset {
  slug: string;
  title: string;
  category: string;
  description: string;
  reference: { media_url: string; duration_sec: number | null; has_audio: boolean };
  inputs: { images: { min: number; max: number }; clips: { min: number; max: number } | null };
}

interface BladeStaged {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'unknown';
  /** Pass to the sandbox's input_media as-is; null while the media is still rendering. */
  stage: { source: string; path: string } | null;
}

interface BladeSessionSummary {
  session_id: string;
  status: string;
  preset: string | null;
  project_id: string;
  created_at: string;
  updated_at: string;
  spent_credits: number;
  final: { video_generation_id: string; timeline_id: string | null } | null;
}

interface BladeSession {
  object: 'blade_session';
  id: string;
  project_id: string;
  preset: string | null;
  status: string;
  quoted_credits: number | null;
  cap_credits: number | null;
  run_ids: string[];
  spent_credits: number;
  final: { video_generation_id: string; timeline_id: string | null; video_url: string | null } | null;
  reference?: BladeStaged | null;
  inputs?: BladeStaged[];
  notes?: string[];
  delivery?: { filed: boolean; credits: { pending_run_ids: string[]; over_cap: boolean } };
}

const collect = (value: string, previous: string[]) => previous.concat(value.split(',').map((s) => s.trim()).filter(Boolean));
const sessionPath = (id: string, suffix = '') => `/blade/sessions/${encodeURIComponent(id)}${suffix}`;

function printNotes(notes: string[] | undefined): void {
  for (const n of notes ?? []) process.stdout.write(`${yellow('note')} ${n}\n`);
}

function printStages(reference: BladeStaged | null | undefined, inputs: BladeStaged[] | undefined): void {
  const rows = [...(reference ? [{ ...reference, role: 'reference' }] : []), ...(inputs ?? []).map((i) => ({ ...i, role: 'input' }))];
  for (const r of rows) {
    process.stdout.write(`${dim(r.role === 'reference' ? 'Reference:' : 'Input:    ')} ${r.stage ? `${r.stage.path}  ${dim(`← ${r.stage.source.length > 60 ? `${r.stage.source.slice(0, 57)}…` : r.stage.source}`)}` : `${r.id}  ${dim('(still rendering)')}`}  ${dim(r.kind)}\n`);
  }
}

function printSession(s: BladeSession): void {
  process.stdout.write(`${bold(s.id)}  ${dim(s.status)}\n`);
  process.stdout.write(`${dim('Project:')}  ${s.project_id}\n`);
  if (s.preset) process.stdout.write(`${dim('Preset:')}   ${s.preset}\n`);
  if (s.quoted_credits !== null || s.cap_credits !== null) {
    process.stdout.write(`${dim('Quote:')}    ${s.quoted_credits ?? '—'} credits (cap ${s.cap_credits ?? '—'})\n`);
  }
  if (s.run_ids.length) process.stdout.write(`${dim('Spent:')}    ${s.spent_credits} credits over ${s.run_ids.length} run${s.run_ids.length === 1 ? '' : 's'}\n`);
  if (s.final) {
    process.stdout.write(`${dim('Final:')}    ${s.final.video_generation_id}${s.final.video_url ? `  ${s.final.video_url}` : ''}\n`);
    if (s.final.timeline_id) process.stdout.write(`${dim('Timeline:')} ${s.final.timeline_id}\n`);
  }
  if (!s.final) printStages(s.reference, s.inputs);
  printNotes(s.notes);
}

export function registerBladeCommand(program: Command): void {
  const blade = program
    .command('blade', { hidden: true })
    .description('Blade reference edits: cut photos and clips like a reference edit');

  blade
    .command('presets [slug]')
    .description('List Blade presets, or show one')
    .action(async (slug?: string) => {
      if (slug) {
        const preset = await publicApiRequest<BladePreset>('GET', `/blade/presets/${encodeURIComponent(slug)}`);
        printResult(preset, () => {
          process.stdout.write(`${bold(preset.title)}  ${dim(preset.slug)}  ${dim(preset.category)}\n`);
          if (preset.description) process.stdout.write(`${preset.description}\n`);
          process.stdout.write(`${dim('Reference:')} ${preset.reference.media_url}\n`);
        });
        return;
      }
      const list = await publicApiRequest<{ object: 'list'; data: BladePreset[] }>('GET', '/blade/presets');
      printResult(list, () => {
        if (list.data.length === 0) {
          process.stdout.write(`${dim('No presets yet. Bring your own reference: genfire blade start --reference <id|url> --input …')}\n`);
          return;
        }
        printTable(list.data.map((p) => ({
          slug: p.slug,
          title: p.title,
          category: p.category,
          seconds: p.reference.duration_sec ?? '',
          inputs: `${p.inputs.images.min}–${p.inputs.images.max + (p.inputs.clips?.max ?? 0)}`,
        })), ['slug', 'title', 'category', 'seconds', 'inputs']);
      });
    });

  blade
    .command('start')
    .description('Start a Blade edit (creates a project unless --project is given)')
    .option('--preset <slug>', 'Preset slug from `genfire blade presets`')
    .option('--reference <id|url>', 'Your own reference edit (run id, generation id or https URL)')
    .option('-i, --input <id|url>', 'A photo or clip to cut (repeatable, or comma-separated)', collect, [] as string[])
    .option('-n, --note <text>', 'What you want')
    .option('-p, --project <projectId>', 'File the result into this project')
    .option('--key <key>', 'Idempotency key (a retry with the same key returns the same session)')
    .action(async (opts: { preset?: string; reference?: string; input: string[]; note?: string; project?: string; key?: string }) => {
      const body: Record<string, unknown> = {
        ...(opts.preset ? { preset: opts.preset } : {}),
        ...(opts.reference ? { reference_media_id: opts.reference } : {}),
        ...(opts.input.length ? { input_media_ids: opts.input } : {}),
        ...(opts.note ? { note: opts.note } : {}),
        ...(opts.project ? { project_id: opts.project } : {}),
      };
      const out = await publicApiRequest<{ session_id: string; project_id: string; project_created: boolean; reference: BladeStaged | null; inputs: BladeStaged[]; next: string[]; notes: string[] }>(
        'POST', '/blade/sessions', { body, idempotencyKey: opts.key || randomUUID() },
      );
      printResult(out, () => {
        process.stdout.write(`${green('✓')} Started ${bold(out.session_id)}  ${dim(`project ${out.project_id}${out.project_created ? ' (new)' : ''}`)}\n`);
        printStages(out.reference, out.inputs);
        out.next.forEach((step, i) => process.stdout.write(`${dim(`${i + 1}.`)} ${step}\n`));
        printNotes(out.notes);
      });
    });

  blade
    .command('status [sessionId]')
    .description('Show a Blade session (quote, spend, staged inputs, the delivered result), or list your sessions')
    .option('-l, --limit <n>', 'List: rows per page (default 20, max 50)')
    .option('--cursor <cursor>', 'List: next_cursor from the previous page')
    .action(async (sessionId: string | undefined, opts: { limit?: string; cursor?: string }) => {
      if (sessionId) {
        const s = await publicApiRequest<BladeSession>('GET', sessionPath(sessionId));
        printResult(s, () => printSession(s));
        return;
      }
      const q = new URLSearchParams();
      if (opts.limit) q.set('limit', opts.limit);
      if (opts.cursor) q.set('cursor', opts.cursor);
      const qs = q.toString();
      const list = await publicApiRequest<{ object: 'list'; data: BladeSessionSummary[]; next_cursor: string | null }>('GET', `/blade/sessions${qs ? `?${qs}` : ''}`);
      printResult(list, () => {
        if (list.data.length === 0) {
          process.stdout.write(`${dim('No Blade sessions yet. Start one: genfire blade start --preset <slug> --input …')}\n`);
          return;
        }
        printTable(list.data.map((r) => ({
          session: r.session_id,
          status: r.status,
          preset: r.preset ?? '',
          project: r.project_id,
          credits: r.spent_credits,
          created: r.created_at.slice(0, 16).replace('T', ' '),
        })), ['session', 'status', 'preset', 'project', 'credits', 'created']);
        if (list.next_cursor) process.stdout.write(`${dim(`More: genfire blade status --cursor ${list.next_cursor}`)}\n`);
      });
    });

  blade
    .command('quote <sessionId>')
    .description("Record the plan's credit estimate and the cap the user agreed to")
    .option('--quoted <credits>', "The plan's estimated total")
    .option('--cap <credits>', 'The most to spend (defaults to the quote)')
    .action(async (sessionId: string, opts: { quoted?: string; cap?: string }) => {
      const s = await publicApiRequest<BladeSession>('POST', sessionPath(sessionId, '/quote'), {
        body: {
          ...(opts.quoted !== undefined ? { quoted_credits: Number(opts.quoted) } : {}),
          ...(opts.cap !== undefined ? { cap_credits: Number(opts.cap) } : {}),
        },
      });
      printResult(s, () => printSession(s));
    });

  blade
    .command('finish <sessionId>')
    .description('Deliver a Blade edit: file the final video into the project and total the spend')
    .option('--video <generationId>', "The final video's generation id")
    .option('--run <runId>', 'Or the run that produced the final video')
    .option('--timeline <timelineId>', 'An editable timeline that already exists (tl_…)')
    .option('--timeline-file <path>', 'Or a timeline manifest (the timeline.json `gf assemble` writes): created in the project')
    .option('-r, --run-ids <runId>', 'A run this edit started (repeatable, or comma-separated)', collect, [] as string[])
    .action(async (sessionId: string, opts: { video?: string; run?: string; timeline?: string; timelineFile?: string; runIds: string[] }) => {
      let timeline: unknown;
      if (opts.timelineFile) {
        try {
          timeline = JSON.parse(readFileSync(opts.timelineFile, 'utf8'));
        } catch (e) {
          throw new Error(`Could not read the timeline manifest ${opts.timelineFile}: ${(e as Error).message}`);
        }
      }
      const s = await publicApiRequest<BladeSession>('POST', sessionPath(sessionId, '/complete'), {
        body: {
          ...(opts.video ? { video_generation_id: opts.video } : {}),
          ...(opts.run ? { run_id: opts.run } : {}),
          ...(opts.timeline ? { timeline_id: opts.timeline } : {}),
          ...(timeline && typeof timeline === 'object' ? { timeline } : {}),
          ...(opts.runIds.length ? { run_ids: opts.runIds } : {}),
        },
      });
      printResult(s, () => {
        process.stdout.write(`${green('✓')} Delivered${s.delivery && !s.delivery.filed ? ' (not filed into the project — see notes)' : ''}\n`);
        printSession(s);
        const pending = s.delivery?.credits.pending_run_ids ?? [];
        if (pending.length) process.stdout.write(`${dim(`Still settling: ${pending.join(', ')} — run finish again for the final total.`)}\n`);
      });
    });
}
