import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Skill } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, yellow } from '../output.js';

function printSkill(skill: Skill): void {
  process.stdout.write(`${bold(skill.title)}${skill.version ? dim('  v' + skill.version) : ''}\n`);
  process.stdout.write(`${dim('ID:')}       ${skill.id}\n`);
  if (skill.slug) process.stdout.write(`${dim('Slug:')}     ${skill.slug}\n`);
  if (skill.category) process.stdout.write(`${dim('Category:')} ${skill.category}\n`);
  if (skill.description) process.stdout.write(`${dim('About:')}    ${skill.description}\n`);
  process.stdout.write(`${dim('Public:')}   ${skill.is_public ? green('yes') : dim('no')}\n`);
  if (skill.files.length) {
    process.stdout.write(`${dim('Files:')}    ${skill.files.map((f) => f.path).join(', ')}\n`);
  }
  if (typeof skill.installs === 'number') {
    process.stdout.write(`${dim('Installs:')} ${skill.installs}\n`);
  }
  if (skill.owner_name) process.stdout.write(`${dim('Author:')}   ${skill.owner_name}\n`);
}

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command('skills')
    .description('Create, publish, and install reusable skills');

  skills
    .command('list')
    .description('List the skills installed in your account')
    .action(async () => {
      const client = await createClient();
      const response = await client.listSkills();
      printResult(response, () => {
        printTable(
          response.data.map((s) => ({
            id: s.id,
            title: s.title,
            category: s.category || '—',
            version: s.version || '—',
            public: s.is_public ? 'yes' : 'no'
          })),
          ['id', 'title', 'category', 'version', 'public']
        );
      });
    });

  skills
    .command('market')
    .description('Browse published skills you can install')
    .action(async () => {
      const client = await createClient();
      const response = await client.listSkillMarket();
      printResult(response, () => {
        printTable(
          response.data.map((s) => ({
            id: s.id,
            title: s.title,
            author: s.owner_name || '—',
            installs: s.installs ?? 0,
            category: s.category || '—'
          })),
          ['id', 'title', 'author', 'installs', 'category']
        );
        process.stdout.write(`${dim('Install one with:')} genfire skills install <id>\n`);
      });
    });

  skills
    .command('create <title>')
    .description('Save a skill from a SKILL.md file or an inline body. Free.')
    .option('-f, --file <path>', 'Path to the SKILL.md markdown body')
    .option('-c, --content <markdown>', 'Inline markdown body (alternative to --file)')
    .option('--prompt <text>', 'Prompt-only skill (alternative to a markdown body)')
    .option('-d, --description <text>', 'Short description (max 300 chars)')
    .option('--category <name>', 'Category (max 40 chars)')
    .option('--slug <slug>', 'URL slug (defaults to a slugified title)')
    .option('-v, --version <semver>', 'Version string', '1.0.0')
    .option('--attach <path...>', 'Extra files to bundle with the skill')
    .option('--publish', 'Publish to the marketplace immediately')
    .action(async (title: string, opts: {
      file?: string; content?: string; prompt?: string; description?: string; category?: string;
      slug?: string; version: string; attach?: string[]; publish?: boolean;
    }) => {
      let content = opts.content;
      if (opts.file) {
        try {
          content = await readFile(opts.file, 'utf8');
        } catch (err) {
          throw new CliError(`Could not read --file ${opts.file}: ${(err as Error).message}`, 'invalid_skill_file');
        }
      }
      if (!content && !opts.prompt) {
        throw new CliError(
          'Provide the skill body: --file <SKILL.md>, --content <markdown>, or --prompt <text>.',
          'missing_skill_body'
        );
      }

      const files = [];
      for (const path of opts.attach || []) {
        try {
          files.push({ path: basename(path), content: await readFile(path, 'utf8') });
        } catch (err) {
          throw new CliError(`Could not read --attach ${path}: ${(err as Error).message}`, 'invalid_attachment');
        }
      }

      const client = await createClient();
      const skill = await client.createSkill({
        title,
        slug: opts.slug,
        description: opts.description,
        category: opts.category,
        content,
        prompt: opts.prompt,
        version: opts.version,
        files: files.length ? files : undefined,
        publish: opts.publish
      });
      printResult(skill, () => {
        process.stdout.write(`${green('✓')} Skill saved${opts.publish ? ' and published' : ''}\n`);
        printSkill(skill);
      });
    });

  skills
    .command('publish <skillId>')
    .description('Publish a skill to the marketplace')
    .action(async (skillId: string) => {
      const client = await createClient();
      const result = await client.publishSkill(skillId, true);
      printResult(result, () => {
        process.stdout.write(`${green('✓')} Published ${result.id}\n`);
      });
    });

  skills
    .command('unpublish <skillId>')
    .description('Remove a skill from the marketplace')
    .action(async (skillId: string) => {
      const client = await createClient();
      const result = await client.publishSkill(skillId, false);
      printResult(result, () => {
        process.stdout.write(`${yellow('✓')} Unpublished ${result.id}\n`);
      });
    });

  skills
    .command('install <publishedId>')
    .description('Install a published skill into your account')
    .action(async (publishedId: string) => {
      const client = await createClient();
      const skill = await client.installSkill(publishedId);
      printResult(skill, () => {
        process.stdout.write(`${green('✓')} Installed ${bold(skill.title)}\n`);
        printSkill(skill);
      });
    });

  skills
    .command('show <skillId>')
    .description('Print a skill body (from your installed skills)')
    .action(async (skillId: string) => {
      const client = await createClient();
      const response = await client.listSkills();
      const skill = response.data.find((s) => s.id === skillId || s.slug === skillId);
      if (!skill) {
        throw new CliError(`No installed skill with id or slug "${skillId}".`, 'skill_not_found');
      }
      printResult(skill, () => {
        printSkill(skill);
        if (skill.content) {
          process.stdout.write(`\n${dim('─── SKILL.md ───')}\n${skill.content}\n`);
        } else if (skill.prompt) {
          process.stdout.write(`\n${dim('─── prompt ───')}\n${skill.prompt}\n`);
        }
      });
    });
}
