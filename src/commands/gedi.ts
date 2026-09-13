import { Command } from 'commander';
import { publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, printResult, printTable } from '../output.js';

/**
 * `genfire gedi` — Genfire Gedi: motion transfer and video edit.
 *
 * Both halves are ONE `genfire generate video` call on `video.seedance_2_5`
 * with a different `--task`:
 *
 *   --task reference  MOTION TRANSFER. The clip supplies the motion, your
 *                     images supply who performs it. Aspect + duration yours.
 *   --task editing    VIDEO EDIT. The clip itself is re-lit / swapped / cleaned
 *                     up. The output follows the SOURCE, so aspect and duration
 *                     are coerced to auto — don't pass them.
 *   --task extension  Continue the clip past its last frame.
 *
 * What this command adds is the RECIPE BOOK. Every preset here carries a prompt
 * already written in the `@Video1` / `@Image1` citation idiom the model binds
 * on — a prompt that never names its references gives the model no reason to
 * use them, and that is the single most common way a first Gedi run comes back
 * looking like a fresh generation instead of an edit.
 *
 * Both reads are FREE and both go through `publicApiRequest`: the CLI pins the
 * PUBLISHED @genfire/sdk 0.23.0 and these routes postdate it. The SDK source in
 * this repo types them (listGediPresets / listGediMotionLibrary) and ships in
 * 0.24.0, so this file collapses onto typed methods once that is cut — the dep
 * is deliberately NOT bumped ahead of the publish, which would break install.
 */

const GEDI_GROUPS = ['relight', 'swap', 'reframe', 'cleanup', 'restyle', 'draw'] as const;

interface GediEditPreset {
  id: string;
  label: string;
  group: string;
  task: 'editing';
  prompt: string;
  requires_image: boolean;
  restyle_preset_id: string | null;
  coming_soon: boolean;
}

interface GediMotionPreset {
  id: string;
  label: string;
  task: 'reference';
  prompt: string;
  images: number;
}

interface GediPresetsResponse {
  object: 'gedi_presets';
  model: string;
  edit_groups: Array<{ id: string; label: string; blurb: string }>;
  edit_presets: GediEditPreset[];
  motion_presets: GediMotionPreset[];
}

interface GediMotion {
  id: string;
  title: string;
  media_url: string;
  thumbnail_url: string | null;
  duration: number | null;
  aspect_ratio: string | null;
  tags: string[];
  prompt: string | null;
}

interface GediMotionLibraryResponse {
  object: 'list';
  data: GediMotion[];
}

/** Enough of a prompt to read in a table cell without wrapping the terminal. */
function clip(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function registerGediCommand(program: Command): void {
  const gedi = program
    .command('gedi')
    .description('Genfire Gedi: motion transfer and video edit recipes for video.seedance_2_5');

  gedi
    .command('presets')
    .description('List the video-edit and motion-transfer recipes (prompts included)')
    .option('--group <group>', `Only one edit family: ${GEDI_GROUPS.join(', ')}`)
    .action(async (opts: { group?: string }) => {
      if (opts.group && !(GEDI_GROUPS as readonly string[]).includes(opts.group)) {
        throw new CliError(
          `--group must be one of: ${GEDI_GROUPS.join(', ')}.`,
          'invalid_group'
        );
      }
      const query = opts.group ? `?group=${encodeURIComponent(opts.group)}` : '';
      const response = await publicApiRequest<GediPresetsResponse>('GET', `/videos/gedi/presets${query}`);

      printResult(response, () => {
        process.stdout.write(`${bold('Video edit')} ${dim(`(--task editing · ${response.model})`)}\n`);
        if (response.edit_presets.length === 0) {
          process.stdout.write(`${dim('No edit presets in that group.')}\n`);
        } else {
          printTable(
            response.edit_presets.map((preset) => ({
              id: preset.id,
              label: preset.label,
              group: preset.group,
              needs: preset.requires_image ? 'video + image' : 'video',
              status: preset.coming_soon ? 'coming soon' : '',
              prompt: clip(preset.prompt)
            })),
            ['id', 'label', 'group', 'needs', 'status', 'prompt']
          );
        }

        process.stdout.write(`\n${bold('Motion transfer')} ${dim('(--task reference)')}\n`);
        printTable(
          response.motion_presets.map((preset) => ({
            id: preset.id,
            label: preset.label,
            images: String(preset.images),
            prompt: clip(preset.prompt)
          })),
          ['id', 'label', 'images', 'prompt']
        );

        process.stdout.write(
          `\n${dim('Full prompt for one preset:')} ${cyan('genfire gedi presets --json')}\n`
          + `${dim('Run an edit:')} ${cyan('genfire generate video "<preset prompt>" -m video.seedance_2_5 --task editing --ref-video ./take.mp4 --ref-image ./new-product.png')}\n`
          + `${dim('Run a transfer:')} ${cyan('genfire generate video "<preset prompt>" -m video.seedance_2_5 --task reference --ref-video ./dance.mp4 --ref-image ./character.png -a 9:16 -d 6')}\n`
          + `${dim('An editing run follows the source clip — leave -a and -d off.')}\n`
        );
      });
    });

  gedi
    .command('motion-library')
    .description('List curated reference clips whose motion you can transfer onto your own subject')
    .option('--limit <n>', 'Maximum entries to return (1-100)')
    .action(async (opts: { limit?: string }) => {
      const query = opts.limit ? `?limit=${encodeURIComponent(opts.limit)}` : '';
      const response = await publicApiRequest<GediMotionLibraryResponse>('GET', `/videos/gedi/motion-library${query}`);

      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('The Motion Library is empty.')}\n`);
          process.stdout.write(
            `${dim('Use your own clip instead:')} ${cyan('genfire generate video "Transfer the motion in @Video1 onto @Image1" -m video.seedance_2_5 --task reference --ref-video ./clip.mp4 --ref-image ./character.png')}\n`
          );
          return;
        }
        printTable(
          response.data.map((motion) => ({
            id: motion.id,
            title: motion.title,
            seconds: motion.duration === null ? '' : String(motion.duration),
            ratio: motion.aspect_ratio ?? '',
            tags: motion.tags.join(', '),
            url: motion.media_url
          })),
          ['id', 'title', 'seconds', 'ratio', 'tags', 'url']
        );
        process.stdout.write(
          `\n${dim('Transfer one:')} ${cyan('genfire generate video "<prompt>" -m video.seedance_2_5 --task reference --ref-video <url> --ref-image ./character.png')}\n`
          + `${dim('Each entry carries a suggested prompt —')} ${cyan('genfire gedi motion-library --json')}\n`
        );
      });
    });
}
