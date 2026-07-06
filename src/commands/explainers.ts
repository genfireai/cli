import { Command } from 'commander';
import type { ExplainerScript } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { dim, printResult, printTable } from '../output.js';

/**
 * Read + parse a structured explainer script from a JSON file (the
 * `--script-file` flag on `generate explainer` and `explainers estimate`).
 * The file must contain the script object itself: { cast?, beats: [...] }.
 */
export async function readExplainerScriptFile(path: string): Promise<ExplainerScript> {
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new CliError(`Could not read --script-file ${path}: ${(err as Error).message}`, 'invalid_script_file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`--script-file ${path} is not valid JSON: ${(err as Error).message}`, 'invalid_script_file');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as ExplainerScript).beats)) {
    throw new CliError(
      `--script-file ${path} must contain a script object like { "beats": [{ "narration": "...", "visual": "..." }, ...] }`,
      'invalid_script_file'
    );
  }
  return parsed as ExplainerScript;
}

export function registerExplainersCommand(program: Command): void {
  const explainers = program
    .command('explainers')
    .description('Explainer-film style catalog and cost estimates');

  explainers
    .command('styles')
    .description('List visual styles (pass as --style to `generate explainer`)')
    .action(async () => {
      const client = await createClient();
      const styles = await client.listExplainerStyles();
      printResult(styles, () => {
        printTable(
          styles.map((s) => ({ id: s.id, label: s.label })),
          ['id', 'label']
        );
      });
    });

  explainers
    .command('estimate')
    .description('Estimate the credit cost of an explainer before generating it')
    .option('-d, --duration <seconds>', 'Target length in seconds (20–600)')
    .option('--motion-level <level>', 'full | mixed | stills')
    .option('--music-source <source>', 'none | preset | ai | library', 'none')
    .option('--script-file <path>', 'JSON file with a structured script (duration then derives from its narration; --duration is ignored)')
    .action(async (opts: { duration?: string; motionLevel?: string; musicSource?: string; scriptFile?: string }) => {
      const client = await createClient();
      const script = opts.scriptFile ? await readExplainerScriptFile(opts.scriptFile) : undefined;
      const estimate = await client.estimateExplainerCost({
        target_duration_sec: opts.duration ? Number(opts.duration) : undefined,
        motion_level: opts.motionLevel as ('full' | 'mixed' | 'stills') | undefined,
        music: opts.musicSource ? { source: opts.musicSource as 'none' | 'preset' | 'ai' | 'library' } : undefined,
        script
      });
      printResult(estimate, () => {
        process.stdout.write(
          `${dim('duration:')}  ${estimate.effective_duration_sec}s\n` +
          `${dim('scenes:')}    ${estimate.sceneCount} (${estimate.animatedScenes} animated)\n` +
          `${dim('images:')}    ${estimate.images}\n` +
          `${dim('voiceover:')} ${estimate.voiceover}\n` +
          `${dim('music:')}     ${estimate.music}\n` +
          `${dim('video:')}     ${estimate.videoClips}\n` +
          `${dim('total:')}     ${estimate.total} credits\n`
        );
      });
    });
}
