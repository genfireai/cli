import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ColoringBookPlanInput,
  ColoringBorder,
  ColoringComplexity,
  ColoringLineWeight,
  CreateColoringBookRequest,
  PictureBookCastInput,
  PictureBookExportKind,
  PictureBookQuality
} from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, printResult, printTable } from '../output.js';
import { reportRunCompletion, waitForRun } from '../runHelpers.js';

const COMPLEXITIES = new Set(['toddler', 'kids', 'tween', 'adult']);
const LINE_WEIGHTS = new Set(['bold', 'medium', 'fine']);
const BORDERS = new Set(['none', 'thin', 'decorative']);
const QUALITIES = new Set(['low', 'medium']);
const EXPORT_KINDS = new Set(['interior-pdf', 'cover-pdf', 'ebook-pdf', 'images-zip']);

const STUDIO_ORIGIN = 'https://genfire.ai';

function parseEnum<T extends string>(value: string | undefined, allowed: Set<string>, flag: string): T | undefined {
  if (!value) return undefined;
  if (!allowed.has(value)) {
    throw new CliError(`Invalid --${flag}: ${value}. Use ${[...allowed].join(', ')}.`, `invalid_${flag.replace(/-/g, '_')}`);
  }
  return value as T;
}

function parseExportKind(value: string | undefined): PictureBookExportKind {
  if (!value || !EXPORT_KINDS.has(value)) {
    throw new CliError(
      `Invalid --kind: ${value ?? '(missing)'}. Use interior-pdf, cover-pdf, ebook-pdf, or images-zip.`,
      'invalid_export_kind'
    );
  }
  return value as PictureBookExportKind;
}

/** `--cast "BELLA:a rabbit in dungarees"` (repeatable). Character books only. */
function parseCast(values: string[] | undefined): PictureBookCastInput[] | undefined {
  if (!values?.length) return undefined;
  return values.slice(0, 4).map((raw) => {
    const index = raw.indexOf(':');
    if (index <= 0) {
      throw new CliError(`Invalid --cast "${raw}". Use NAME:description.`, 'invalid_cast');
    }
    return {
      name: raw.slice(0, index).trim(),
      description: raw.slice(index + 1).trim()
    };
  });
}

interface ColoringRequestOpts {
  plan?: string;
  title?: string;
  pages?: string;
  complexity?: string;
  lineWeight?: string;
  border?: string;
  style?: string;
  format?: string;
  quality?: string;
  blankBacks?: boolean;
  bleed?: boolean;
  captions?: boolean;
  cast?: string[];
  teamId?: string;
}

async function readPlan(path: string): Promise<ColoringBookPlanInput> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`Could not read --plan file: ${path}`, 'plan_unreadable');
  }
  try {
    return JSON.parse(raw) as ColoringBookPlanInput;
  } catch {
    throw new CliError(`--plan file is not valid JSON: ${path}`, 'plan_invalid_json');
  }
}

async function buildColoringRequest(theme: string | undefined, opts: ColoringRequestOpts): Promise<CreateColoringBookRequest> {
  const plan = opts.plan ? await readPlan(opts.plan) : undefined;
  if (!plan && !theme?.trim()) {
    throw new CliError(
      'Give a theme ("sleepy animals of the forest floor") or --plan with your own page list.',
      'missing_theme'
    );
  }
  const pages = opts.pages ? Number(opts.pages) : undefined;
  if (pages !== undefined && (!Number.isFinite(pages) || pages < 8 || pages > 120)) {
    throw new CliError(`Invalid --pages: ${opts.pages}. Use 8–120.`, 'invalid_pages');
  }
  return {
    plan,
    theme: theme?.trim() || undefined,
    title: opts.title,
    pages,
    complexity: parseEnum<ColoringComplexity>(opts.complexity, COMPLEXITIES, 'complexity'),
    line_weight: parseEnum<ColoringLineWeight>(opts.lineWeight, LINE_WEIGHTS, 'line-weight'),
    border: parseEnum<ColoringBorder>(opts.border, BORDERS, 'border'),
    style_id: opts.style,
    format_id: opts.format,
    quality: parseEnum<PictureBookQuality>(opts.quality, QUALITIES, 'quality'),
    // commander gives `blankBacks: false` only when --no-blank-backs was
    // passed; leaving it undefined otherwise keeps the server's default (on
    // for print), which is the one that is correct for a real coloring book.
    blank_backs: opts.blankBacks === false ? false : undefined,
    bleed: opts.bleed === true ? true : undefined,
    captions: opts.captions === true ? true : undefined,
    cast: parseCast(opts.cast),
    team_id: opts.teamId
  };
}

function studioUrl(bookId: string): string {
  return `${STUDIO_ORIGIN}/dashboard/coloring-books/${encodeURIComponent(bookId)}`;
}

/** Options shared by `estimate-cost` and `create`, in one place so they cannot drift. */
function withRequestOptions(command: Command): Command {
  return command
    .option('--plan <path>', 'Your authored page list as JSON ({ title, theme, pages:[{subject, composition?, caption?}], cover_visual }) — drawn as written, no planner. 8–120 pages, and no two may share a subject')
    .option('-t, --title <title>', 'Book title')
    .option('-p, --pages <n>', 'How many drawings (8–120)')
    .option('-c, --complexity <band>', 'toddler | kids (default) | tween | adult — how much detail is in each drawing')
    .option('--line-weight <weight>', 'bold | medium | fine (defaults to what the complexity reads best at)')
    .option('--border <style>', 'none (default) | thin | decorative')
    .option('-s, --style <id>', 'Subject world id (see: genfire coloring styles)')
    .option('-f, --format <id>', 'Trim id — kdp-8.5x11 default (see: genfire coloring styles)')
    .option('-q, --quality <tier>', 'low (default, drafts) | medium (final)')
    .option('--cast <NAME:description...>', 'Recurring characters (repeatable, max 4) — character coloring books only');
}

export function registerColoringCommand(program: Command): void {
  const coloring = program
    .command('coloring')
    .description('Coloring Book Studio — draw print-ready black-and-white coloring books');

  coloring
    .command('styles')
    .description('List subject worlds, trims and complexity bands (ids for --style / --format / --complexity)')
    .action(async () => {
      const client = await createClient();
      const catalog = await client.listColoringBookStyles();
      printResult(catalog, () => {
        process.stdout.write(`${bold('Worlds')} ${dim('— what gets drawn. The medium is always black ink on white paper.')}\n`);
        printTable(
          catalog.styles.map((s) => ({ id: s.id, label: s.label, tagline: s.tagline, 'best at': s.suggested_complexity })),
          ['id', 'label', 'tagline', 'best at']
        );
        process.stdout.write(`\n${bold('Trims')}\n`);
        printTable(
          catalog.formats.map((f) => ({
            id: f.id, label: f.label, kind: f.kind,
            KDP: f.kdp_ready ? 'yes' : '', note: f.note ?? ''
          })),
          ['id', 'label', 'kind', 'KDP', 'note']
        );
        process.stdout.write(`\n${bold('Detail')}\n`);
        printTable(
          catalog.complexities.map((c) => ({
            id: c.id, label: c.label, ages: c.ages, line: c.line_weight,
            pages: c.page_options.join('/'), note: c.note
          })),
          ['id', 'label', 'ages', 'line', 'pages', 'note']
        );
        process.stdout.write(`\n${dim(`Pages: ${catalog.page_range.min}–${catalog.page_range.max}. Defaults: ${catalog.defaults.style_id} · ${catalog.defaults.format_id} · ${catalog.defaults.complexity} · ${catalog.defaults.quality}`)}\n`);
      });
    });

  withRequestOptions(
    coloring
      .command('estimate-cost [theme]')
      .description('Plan the pages and price the book before drawing anything')
  ).action(async (theme: string | undefined, opts: ColoringRequestOpts) => {
    const client = await createClient();
    const body = await buildColoringRequest(theme, opts);
    const estimate = await client.estimateColoringBookCost(body);
    printResult(estimate, () => {
      process.stdout.write(`${bold(estimate.plan.title)} ${dim(`· ${estimate.plan.pages} pages · prints as ${estimate.printed_interior_pages} interior pages`)}\n`);
      process.stdout.write(`${dim(estimate.plan.theme)}\n\n`);
      // The subject list IS the review — a repetitive book is the failure this
      // command exists to catch, and it only shows up when you read them.
      estimate.plan.subjects.forEach((subject, i) => {
        process.stdout.write(`  ${dim(String(i + 1).padStart(3))}  ${subject}\n`);
      });
      for (const warning of estimate.plan.warnings ?? []) {
        process.stdout.write(`\n  ${dim('⚠ ' + warning)}\n`);
      }
      process.stdout.write(`\n${bold(String(estimate.estimated_credits))} credits ${dim(`(${estimate.config.quality} quality)`)}\n`);
      for (const line of estimate.breakdown) {
        process.stdout.write(`  ${dim(line.label.padEnd(22))} ${String(line.units).padStart(3)} × ${line.unit_credits} = ${line.credits}\n`);
      }
      if (estimate.current_credits != null) {
        process.stdout.write(`${dim(`Balance: ${estimate.current_credits}${estimate.affordable === false ? ' — not enough for this run' : ''}`)}\n`);
      }
    });
  });

  withRequestOptions(
    coloring
      .command('create [theme]')
      .description('Draw a complete coloring book from a theme or your own page list')
  )
    .option('--no-blank-backs', 'Print drawings on both sides of each leaf (markers may show through)')
    .option('--bleed', 'Run the art off all four edges instead of leaving a white border')
    .option('--captions', "Print each page's caption in the margin")
    .option('--team-id <id>', 'Bill a workspace credit pool')
    .option('--no-wait', 'Return the queued run immediately instead of polling')
    .option('--wait-timeout <minutes>', 'Maximum minutes to wait', '45')
    .action(async (theme: string | undefined, opts: ColoringRequestOpts & { wait: boolean; waitTimeout: string }) => {
      const client = await createClient();
      const body = await buildColoringRequest(theme, opts);
      const run = await client.createColoringBook(body, { idempotencyKey: randomUUID() });
      const bookIdAtStart = (run.output as any)?.book_id || run.resource_id || null;

      if (!opts.wait) {
        printResult(run, () => {
          process.stdout.write(`${dim('Run queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
          if (bookIdAtStart) {
            process.stdout.write(`${dim('Book:')} ${bookIdAtStart} ${dim('·')} ${cyan(studioUrl(String(bookIdAtStart)))}\n`);
            process.stdout.write(`${dim('Re-check with:')} genfire coloring get ${bookIdAtStart}\n`);
          } else {
            process.stdout.write(`${dim('Re-check with:')} genfire runs get ${run.id}\n`);
          }
        });
        return;
      }

      const timeoutMinutes = Number(opts.waitTimeout);
      if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
        throw new CliError(`Invalid --wait-timeout: ${opts.waitTimeout}`, 'invalid_wait_timeout');
      }

      let lastStage = '';
      process.stderr.write(`${dim(`Polling run ${run.id}…`)}\n`);
      const completed = await waitForRun(client, run.id, {
        timeoutMs: timeoutMinutes * 60 * 1000,
        onTick: (current) => {
          const stage = current.progress?.label || current.status;
          if (stage && stage !== lastStage) {
            lastStage = stage;
            process.stderr.write(`${dim('  · ' + stage + '…')}\n`);
          }
        }
      });

      const bookId = (completed.output as any)?.book_id || completed.resource_id || bookIdAtStart;
      if (completed.status !== 'completed' || !bookId) {
        reportRunCompletion(completed, []);
        return;
      }
      const book = await client.getColoringBook(String(bookId));
      printResult({ run: completed, book }, () => {
        reportRunCompletion(completed, []);
        process.stdout.write(`${bold(book.title)} ${dim(`· ${book.ready_pages}/${book.page_count} pages drawn · ${book.status}`)}\n`);
        process.stdout.write(`${dim('Open:')} ${cyan(studioUrl(book.id))}\n`);
        process.stdout.write(`${dim('Export:')} genfire coloring export ${book.id} --kind interior-pdf\n`);
      });
    });

  coloring
    .command('get <bookId>')
    .description('Show a coloring book: status, print settings and every page')
    .action(async (bookId: string) => {
      const client = await createClient();
      const book = await client.getColoringBook(bookId) as any;
      printResult(book, () => {
        process.stdout.write(`${bold(book.title)} ${dim(`· ${book.status}${book.progress ? ` · ${book.progress.label} ${book.progress.percent}%` : ''}`)}\n`);
        process.stdout.write(`${dim(`${book.style_id ?? 'custom world'} · ${book.format_id ?? ''} · ${book.complexity ?? ''} · ${book.line_weight ?? ''} line · ${book.quality}`)}\n`);
        // The print facts a self-publisher actually has to know before upload.
        process.stdout.write(`${dim(`Interior: ${book.interior ?? 'black & white'}${book.blank_backs ? ' · blank backs' : ''}${book.bleed ? ' · full bleed' : ' · no bleed'}${book.printed_interior_pages ? ` · prints ${book.printed_interior_pages} pages` : ''}`)}\n`);
        process.stdout.write(`${dim('Open:')} ${cyan(studioUrl(book.id))}\n`);
        process.stdout.write(`\n${bold('Pages')} ${dim(`${book.ready_pages}/${book.page_count} drawn`)}\n`);
        printTable(
          book.pages.map((p: any, i: number) => ({
            '#': p.kind === 'front-cover' ? 'cover' : p.kind === 'back-cover' ? 'back' : (p.page_number ?? String(i)),
            art: p.art_status,
            subject: p.visual?.length > 70 ? `${p.visual.slice(0, 69)}…` : (p.visual ?? '')
          })),
          ['#', 'art', 'subject']
        );
        if (book.exports?.length) {
          process.stdout.write(`\n${bold('Exports')}\n`);
          for (const e of book.exports) process.stdout.write(`  ${e.kind.padEnd(14)} ${cyan(e.url)}\n`);
        }
      });
    });

  coloring
    .command('export <bookId>')
    .description('Export a coloring book (free): interior-pdf | cover-pdf | ebook-pdf | images-zip')
    .requiredOption('-k, --kind <kind>', 'interior-pdf (black & white KDP interior) | cover-pdf (colour wrap) | ebook-pdf | images-zip')
    .action(async (bookId: string, opts: { kind?: string }) => {
      const kind = parseExportKind(opts.kind);
      const client = await createClient();
      const result = await client.exportColoringBook(bookId, kind);
      printResult(result, () => {
        process.stdout.write(`${bold(kind)} ${dim('→')} ${cyan(String(result.url ?? '(no url)'))}\n`);
        for (const w of result.warnings ?? []) process.stdout.write(`  ${dim('⚠ ' + w)}\n`);
      });
    });
}
