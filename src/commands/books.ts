import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  CreatePictureBookRequest, PictureBookPlanInput,
  PictureBookAgeBand,
  PictureBookCastInput,
  PictureBookExportKind,
  PictureBookLettering,
  PictureBookQuality
} from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, printResult, printTable } from '../output.js';
import { reportRunCompletion, waitForRun } from '../runHelpers.js';

const AGE_BANDS = new Set(['board', 'picture', 'early-reader']);
const QUALITIES = new Set(['low', 'medium']);
const LETTERING = new Set(['typeset', 'lettered']);
const EXPORT_KINDS = new Set(['interior-pdf', 'cover-pdf', 'ebook-pdf', 'images-zip']);

const STUDIO_ORIGIN = 'https://genfire.ai';

function parseAgeBand(value: string | undefined): PictureBookAgeBand | undefined {
  if (!value) return undefined;
  if (!AGE_BANDS.has(value)) {
    throw new CliError(`Invalid --age-band: ${value}. Use board, picture, or early-reader.`, 'invalid_age_band');
  }
  return value as PictureBookAgeBand;
}

function parseQuality(value: string | undefined): PictureBookQuality | undefined {
  if (!value) return undefined;
  if (!QUALITIES.has(value)) {
    throw new CliError(`Invalid --quality: ${value}. Use low or medium.`, 'invalid_quality');
  }
  return value as PictureBookQuality;
}

function parseLettering(value: string | undefined): PictureBookLettering | undefined {
  if (!value) return undefined;
  if (!LETTERING.has(value)) {
    throw new CliError(`Invalid --lettering: ${value}. Use typeset or lettered.`, 'invalid_lettering');
  }
  return value as PictureBookLettering;
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

/** `--cast "PIP:a small orange fox kit with a white-tipped tail"` (repeatable). */
function parseCast(values: string[] | undefined): PictureBookCastInput[] | undefined {
  if (!values?.length) return undefined;
  const cast: PictureBookCastInput[] = [];
  for (const raw of values) {
    const idx = raw.indexOf(':');
    if (idx <= 0) {
      throw new CliError(`Invalid --cast "${raw}". Use NAME:description, e.g. "PIP:a small orange fox kit".`, 'invalid_cast');
    }
    cast.push({ name: raw.slice(0, idx).trim().toUpperCase(), description: raw.slice(idx + 1).trim() });
  }
  if (cast.length > 4) throw new CliError('--cast accepts at most 4 characters.', 'too_many_cast');
  return cast;
}

interface BookRequestOpts {
  plan?: string; script?: string; title?: string; ageBand?: string; pages?: string; style?: string; format?: string;
  quality?: string; lettering?: string; cast?: string[]; teamId?: string;
}

/** Build the shared create/estimate body from the command options. */
async function buildBookRequest(idea: string | undefined, opts: BookRequestOpts): Promise<CreatePictureBookRequest> {
  let plan: PictureBookPlanInput | undefined;
  if (opts.plan) {
    const raw = (await readFile(opts.plan, 'utf8')).trim();
    if (!raw) throw new CliError(`--plan file is empty: ${opts.plan}`, 'empty_plan');
    try {
      plan = JSON.parse(raw) as PictureBookPlanInput;
    } catch {
      throw new CliError(`--plan file is not valid JSON: ${opts.plan}`, 'invalid_plan');
    }
    if (!plan || typeof plan !== 'object' || !Array.isArray((plan as any).pages)) {
      throw new CliError('--plan must be a JSON object with "title" and a "pages" array of { text, visual, cast?, place? }.', 'invalid_plan');
    }
  }
  let script: string | undefined;
  if (opts.script) {
    script = (await readFile(opts.script, 'utf8')).trim();
    if (!script) throw new CliError(`--script file is empty: ${opts.script}`, 'empty_script');
  }
  if (!idea && !script && !plan) {
    throw new CliError('Provide --plan <file.json> (your authored book), an idea ("a brave fox who is afraid of the dark") or --script <file> with the full text.', 'missing_idea');
  }
  let pages: number | undefined;
  if (opts.pages !== undefined) {
    pages = Number(opts.pages);
    if (!Number.isInteger(pages) || pages < 4 || pages > 48) {
      throw new CliError(`Invalid --pages: ${opts.pages}. Use an integer between 4 and 48.`, 'invalid_pages');
    }
  }
  return {
    ...(plan ? { plan } : {}),
    ...(idea ? { idea } : {}),
    ...(script ? { script } : {}),
    title: opts.title,
    age_band: parseAgeBand(opts.ageBand),
    pages,
    style_id: opts.style,
    format_id: opts.format,
    quality: parseQuality(opts.quality),
    lettering: parseLettering(opts.lettering),
    cast: parseCast(opts.cast),
    team_id: opts.teamId
  };
}

function studioUrl(bookId: string): string {
  return `${STUDIO_ORIGIN}/dashboard/books/${encodeURIComponent(bookId)}`;
}

export function registerBooksCommand(program: Command): void {
  const books = program
    .command('books')
    .description('Picture Book Studio — write and illustrate picture books with a consistent cast');

  books
    .command('styles')
    .description('List illustration styles, formats and age bands (ids for --style / --format / --age-band)')
    .action(async () => {
      const client = await createClient();
      const catalog = await client.listPictureBookStyles();
      printResult(catalog, () => {
        process.stdout.write(`${bold('Styles')}\n`);
        printTable(
          catalog.styles.map((s) => ({ id: s.id, label: s.label, tagline: s.tagline })),
          ['id', 'label', 'tagline']
        );
        process.stdout.write(`\n${bold('Formats')}\n`);
        printTable(
          catalog.formats.map((f) => ({ id: f.id, label: f.label, kind: f.kind, aspect: f.aspect, note: f.note ?? '' })),
          ['id', 'label', 'kind', 'aspect', 'note']
        );
        process.stdout.write(`\n${bold('Age bands')}\n`);
        printTable(
          catalog.age_bands.map((a) => ({
            id: a.id, label: a.label, ages: a.ages,
            'words/page': `${a.words_per_page[0]}–${a.words_per_page[1]}`,
            pages: a.page_options.join('/'), default: a.default_pages
          })),
          ['id', 'label', 'ages', 'words/page', 'pages', 'default']
        );
        process.stdout.write(`\n${dim(`Defaults: ${catalog.defaults.style_id} · ${catalog.defaults.format_id} · ${catalog.defaults.age_band} · ${catalog.defaults.quality} · ${catalog.defaults.lettering}`)}\n`);
      });
    });

  books
    .command('estimate-cost [idea]')
    .description('Plan a book (title, pages, cast) and price it before generating')
    .option('--plan <path>', 'Your authored book as JSON ({ title, cast, places?: [{name, description}] (≤4 recurring settings), pages:[{text, visual, cast, place?: NAME, kind?: page|text-page|spread}], cover_visual, back_cover_blurb }) — rendered as written, no planner; a spread is one picture across two facing pages (even start page, never page 1)')
    .option('--script <path>', 'Use your own story text (one paragraph per page) instead of an idea')
    .option('-t, --title <title>', 'Book title')
    .option('--age-band <band>', 'board | picture (default) | early-reader')
    .option('-p, --pages <n>', 'Interior page count (within the age band options)')
    .option('-s, --style <id>', 'Illustration style id (see: genfire books styles)')
    .option('-f, --format <id>', 'Format id (see: genfire books styles)')
    .option('-q, --quality <tier>', 'low (default) | medium')
    .option('--lettering <mode>', 'typeset (default) | lettered')
    .option('--cast <NAME:description...>', 'Recurring characters (repeatable, max 4)')
    .action(async (idea: string | undefined, opts: BookRequestOpts) => {
      const client = await createClient();
      const body = await buildBookRequest(idea, opts);
      const estimate = await client.estimatePictureBookCost(body);
      printResult(estimate, () => {
        process.stdout.write(`${bold(estimate.plan.title)} ${dim(`· ${estimate.plan.pages} pages · ${estimate.plan.cast.length} characters`)}\n`);
        process.stdout.write(`${dim(estimate.plan.premise)}\n\n`);
        for (const c of estimate.plan.cast) {
          process.stdout.write(`  ${cyan(c.name.padEnd(14))} ${dim(c.description)}\n`);
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

  books
    .command('create [idea]')
    .description('Write and illustrate a picture book from an idea or your own script')
    .option('--plan <path>', 'Your authored book as JSON ({ title, cast, places?: [{name, description}] (≤4 recurring settings), pages:[{text, visual, cast, place?: NAME, kind?: page|text-page|spread}], cover_visual, back_cover_blurb }) — rendered as written, no planner; a spread is one picture across two facing pages (even start page, never page 1)')
    .option('--script <path>', 'Use your own story text (one paragraph per page) instead of an idea')
    .option('-t, --title <title>', 'Book title')
    .option('--age-band <band>', 'board | picture (default) | early-reader')
    .option('-p, --pages <n>', 'Interior page count (within the age band options)')
    .option('-s, --style <id>', 'Illustration style id (see: genfire books styles)')
    .option('-f, --format <id>', 'Format id — KDP trim, a4 or digital aspect (see: genfire books styles)')
    .option('-q, --quality <tier>', 'low (default, drafts) | medium (final)')
    .option('--lettering <mode>', 'typeset (default: words set in post) | lettered (painted into the art)')
    .option('--cast <NAME:description...>', 'Recurring characters with one physical description each (repeatable, max 4)')
    .option('--team-id <id>', 'Bill a workspace credit pool')
    .option('--no-wait', 'Return the queued run immediately instead of polling')
    .option('--wait-timeout <minutes>', 'Maximum minutes to wait', '30')
    .action(async (idea: string | undefined, opts: BookRequestOpts & { wait: boolean; waitTimeout: string }) => {
      const client = await createClient();
      const body = await buildBookRequest(idea, opts);
      const run = await client.createPictureBook(body, { idempotencyKey: randomUUID() });
      const bookIdAtStart = (run.output as any)?.book_id || run.resource_id || null;

      if (!opts.wait) {
        printResult(run, () => {
          process.stdout.write(`${dim('Run queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
          if (bookIdAtStart) {
            process.stdout.write(`${dim('Book:')} ${bookIdAtStart} ${dim('·')} ${cyan(studioUrl(String(bookIdAtStart)))}\n`);
            process.stdout.write(`${dim('Re-check with:')} genfire books get ${bookIdAtStart}\n`);
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
      const book = await client.getPictureBook(String(bookId));
      printResult({ run: completed, book }, () => {
        reportRunCompletion(completed, []);
        process.stdout.write(`${bold(book.title)} ${dim(`· ${book.ready_pages}/${book.page_count} pages illustrated · ${book.status}`)}\n`);
        process.stdout.write(`${dim('Open:')} ${cyan(studioUrl(book.id))}\n`);
        process.stdout.write(`${dim('Export:')} genfire books export ${book.id} --kind interior-pdf\n`);
      });
    });

  books
    .command('get <bookId>')
    .description('Show a book: status, progress, cast, places and every page')
    .action(async (bookId: string) => {
      const client = await createClient();
      const book = await client.getPictureBook(bookId);
      printResult(book, () => {
        process.stdout.write(`${bold(book.title)} ${dim(`· ${book.status}${book.progress ? ` · ${book.progress.label} ${book.progress.percent}%` : ''}`)}\n`);
        process.stdout.write(`${dim(`${book.age_band} · ${book.style_id ?? 'custom style'} · ${book.format_id ?? ''} · ${book.quality} · ${book.lettering}`)}\n`);
        process.stdout.write(`${dim('Open:')} ${cyan(studioUrl(book.id))}\n`);
        if (book.cast.length) {
          process.stdout.write(`\n${bold('Cast')}\n`);
          printTable(
            book.cast.map((c) => ({ name: c.name, sheet: c.sheet_status, description: c.description })),
            ['name', 'sheet', 'description']
          );
        }
        if (book.places?.length) {
          process.stdout.write(`\n${bold('Places')}\n`);
          printTable(
            book.places.map((pl) => ({ name: pl.name, sheet: pl.sheet_status, description: pl.description })),
            ['name', 'sheet', 'description']
          );
        }
        process.stdout.write(`\n${bold('Pages')} ${dim(`${book.ready_pages}/${book.page_count} illustrated`)}\n`);
        printTable(
          book.pages.map((p, i) => ({
            '#': p.kind === 'front-cover' ? 'cover' : p.kind === 'back-cover' ? 'back' : (p.page_number ?? String(i)),
            art: p.art_status,
            text: p.text.length > 70 ? `${p.text.slice(0, 69)}…` : p.text
          })),
          ['#', 'art', 'text']
        );
        if (book.exports.length) {
          process.stdout.write(`\n${bold('Exports')}\n`);
          for (const e of book.exports) process.stdout.write(`  ${e.kind.padEnd(14)} ${cyan(e.url)}\n`);
        }
      });
    });

  books
    .command('export <bookId>')
    .description('Export a book (free): interior-pdf | cover-pdf | ebook-pdf | images-zip')
    .requiredOption('-k, --kind <kind>', 'interior-pdf (KDP interior) | cover-pdf (KDP wrap) | ebook-pdf | images-zip')
    .action(async (bookId: string, opts: { kind?: string }) => {
      const kind = parseExportKind(opts.kind);
      const client = await createClient();
      const result = await client.exportPictureBook(bookId, kind);
      printResult(result, () => {
        process.stdout.write(`${bold(kind)} ${dim('→')} ${cyan(String(result.url ?? '(no url)'))}\n`);
        for (const w of result.warnings ?? []) process.stdout.write(`  ${dim('⚠ ' + w)}\n`);
      });
    });
}
