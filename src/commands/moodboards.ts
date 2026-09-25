import { Command } from 'commander';
import { publicApiRequest } from '../client.js';
import { bold, cyan, dim, green, printResult, printTable } from '../output.js';

/**
 * Moodboards — `/v1/moodboards`. A saved aesthetic: images analyzed once into a
 * reusable style profile (prompt fragment + exemplar references). READ-ONLY on
 * /v1 apart from forking a house preset into your own boards (free, no
 * Idempotency-Key). Use a board with `moodboard_id` on an image generation.
 */

interface MoodboardImage {
  id: string;
  url: string;
  thumbnail_url: string | null;
  source: string;
}

interface MoodboardAnalysis {
  status: string;
  taste_profile: string;
  keywords: string[];
  avoids: string[];
  palette: unknown;
  exemplar_image_ids: string[];
  prompt_fragment: string;
}

interface MoodboardRecord {
  id: string;
  object: 'moodboard' | 'moodboard_preset';
  name: string;
  image_count: number;
  images: MoodboardImage[];
  analysis: MoodboardAnalysis | null;
  guidelines: string | null;
  created_at: string | null;
  updated_at: string | null;
  order?: number;
}

function printBoard(board: MoodboardRecord): void {
  process.stdout.write(`${bold(board.name)}  ${dim(board.id)}\n`);
  process.stdout.write(`${dim('Images:')}    ${board.image_count}\n`);
  const a = board.analysis;
  if (a) {
    process.stdout.write(`${dim('Analysis:')}  ${a.status}\n`);
    if (a.keywords?.length) process.stdout.write(`${dim('Keywords:')}  ${a.keywords.join(', ')}\n`);
    if (a.avoids?.length) process.stdout.write(`${dim('Avoids:')}    ${a.avoids.join(', ')}\n`);
    if (a.taste_profile) process.stdout.write(`${dim('Profile:')}   ${a.taste_profile}\n`);
  }
  if (board.guidelines) process.stdout.write(`${dim('Guidelines:')} ${board.guidelines}\n`);
  for (const img of board.images ?? []) {
    process.stdout.write(`  ${dim(img.id)} ${cyan(img.url)}\n`);
  }
}

function boardRows(boards: MoodboardRecord[]) {
  return boards.map((b) => ({
    id: b.id,
    name: b.name,
    images: b.image_count,
    analysis: b.analysis?.status ?? '',
    keywords: (b.analysis?.keywords ?? []).slice(0, 5).join(', ')
  }));
}

export function registerMoodboardsCommand(program: Command): void {
  const moodboards = program
    .command('moodboards')
    .description('Browse your moodboards (saved aesthetics) and fork house presets');

  moodboards
    .command('list')
    .description('List your own moodboards (team-shared boards stay usable by id)')
    .action(async () => {
      const response = await publicApiRequest<{ object: 'list'; data: MoodboardRecord[] }>('GET', '/moodboards');
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No moodboards yet. Fork a house preset: genfire moodboards presets')}\n`);
          return;
        }
        printTable(boardRows(response.data), ['id', 'name', 'images', 'analysis', 'keywords']);
      });
    });

  moodboards
    .command('get <moodboardId>')
    .description('Show a moodboard: its images and analyzed style profile')
    .action(async (moodboardId: string) => {
      const board = await publicApiRequest<MoodboardRecord>('GET', `/moodboards/${encodeURIComponent(moodboardId)}`);
      printResult(board, () => printBoard(board));
    });

  moodboards
    .command('presets')
    .description('List the house-curated moodboard presets you can fork')
    .action(async () => {
      const response = await publicApiRequest<{ object: 'list'; data: MoodboardRecord[] }>('GET', '/moodboards/presets');
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No presets available.')}\n`);
          return;
        }
        printTable(boardRows(response.data), ['id', 'name', 'images', 'analysis', 'keywords']);
        process.stdout.write(`\n${dim('Copy one into your boards: genfire moodboards fork <presetId>')}\n`);
      });
    });

  moodboards
    .command('fork <presetId>')
    .description('Copy a house preset into your own moodboards (free)')
    .action(async (presetId: string) => {
      const board = await publicApiRequest<MoodboardRecord>(
        'POST',
        `/moodboards/presets/${encodeURIComponent(presetId)}/fork`
      );
      printResult(board, () => {
        process.stdout.write(`${green('✓')} Forked into ${bold(board.name)}  ${dim(board.id)}\n`);
      });
    });
}
