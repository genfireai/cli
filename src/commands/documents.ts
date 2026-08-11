import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, yellow } from '../output.js';

/**
 * Read HTML from a file, or use the literal string when no file matches. Lets
 * `--html <file>` and `--html '<h1>…</h1>'` both work, which is what people
 * reach for when scripting.
 */
async function resolveHtml(value: string | undefined, file: string | undefined, flag: string): Promise<string> {
  if (file) {
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      throw new CliError(`Could not read ${flag}-file ${file}: ${(err as Error).message}`, 'invalid_html_file');
    }
  }
  if (value === undefined) {
    throw new CliError(`Provide ${flag} <html> or ${flag}-file <path>.`, 'missing_html');
  }
  return value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function registerDocumentsCommand(program: Command): void {
  const documents = program
    .command('documents')
    .description('Author shareable HTML documents (reports, pages, decks) in your Drive');

  documents
    .command('list')
    .description('List the documents in your Drive')
    .action(async () => {
      const client = await createClient();
      const response = await client.listDocuments();
      printResult(response, () => {
        printTable(
          response.data.map((d) => ({ id: d.id, title: d.title, size: formatBytes(d.bytes), url: d.url })),
          ['id', 'title', 'size', 'url']
        );
      });
    });

  documents
    .command('create')
    .description('Create a document and get a permanent shareable URL. Free.')
    .option('-t, --title <title>', 'Document title')
    .option('--kind <kind>', "'document' (default) or 'deck'")
    .option('--html <html>', 'Document body as an HTML string')
    .option('--html-file <path>', 'Read the HTML body from a file')
    .option('-d, --description <text>', 'Short description')
    .action(async (opts: { title?: string; kind?: string; html?: string; htmlFile?: string; description?: string }) => {
      const html = await resolveHtml(opts.html, opts.htmlFile, '--html');
      const client = await createClient();
      const doc = await client.createDocument({
        title: opts.title,
        kind: opts.kind,
        html,
        description: opts.description
      });
      printResult(doc, () => {
        process.stdout.write(`${green('✓')} Created ${bold(doc.title || doc.id)}\n`);
        process.stdout.write(`${dim('ID:')}    ${doc.id}\n`);
        process.stdout.write(`${dim('Size:')}  ${formatBytes(doc.bytes)}\n`);
        process.stdout.write(`${dim('URL:')}   ${cyan(doc.url)}\n`);
      });
    });

  documents
    .command('append <documentId>')
    .description('Append HTML to the end of a document — how long documents are built up in chunks')
    .option('--html <html>', 'HTML to append')
    .option('--html-file <path>', 'Read the HTML to append from a file')
    .action(async (documentId: string, opts: { html?: string; htmlFile?: string }) => {
      const html = await resolveHtml(opts.html, opts.htmlFile, '--html');
      const client = await createClient();
      const result = await client.appendDocument(documentId, html);
      printResult(result, () => {
        process.stdout.write(`${green('✓')} Appended to ${result.id}\n`);
        process.stdout.write(`${dim('Size:')}  ${formatBytes(result.bytes)}\n`);
        process.stdout.write(`${dim('URL:')}   ${cyan(result.url)}\n`);
      });
    });

  documents
    .command('edit <documentId>')
    .description('Find-and-replace inside a document')
    .requiredOption('--find <text>', 'Exact text to find')
    .requiredOption('--replace <text>', 'Replacement text')
    .action(async (documentId: string, opts: { find: string; replace: string }) => {
      const client = await createClient();
      const result = await client.editDocument(documentId, opts.find, opts.replace);
      printResult(result, () => {
        if (result.occurrences === 0) {
          process.stdout.write(`${yellow('No matches')} — the --find text was not present; document unchanged.\n`);
        } else {
          process.stdout.write(`${green('✓')} Replaced ${result.occurrences} occurrence${result.occurrences === 1 ? '' : 's'}\n`);
        }
        process.stdout.write(`${dim('Size:')}  ${formatBytes(result.bytes)}\n`);
        process.stdout.write(`${dim('URL:')}   ${cyan(result.url)}\n`);
      });
    });
}
