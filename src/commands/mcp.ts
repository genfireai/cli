import { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveApiKey } from '../config.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, yellow } from '../output.js';

const execFileAsync = promisify(execFile);

const MCP_SERVER_URL = 'https://mcp.genfire.ai/mcp';

type McpClient = 'claude-code' | 'claude-desktop' | 'cursor';

function claudeDesktopConfigPath(): string {
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function cursorConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

async function setupClaudeCode(apiKey: string): Promise<void> {
  try {
    await execFileAsync('claude', [
      'mcp', 'add',
      '--transport', 'http',
      'genfire',
      MCP_SERVER_URL,
      '--header', `Authorization: Bearer ${apiKey}`
    ]);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new CliError(
        'claude CLI not found. Install Claude Code first: https://claude.ai/code',
        'claude_cli_not_found'
      );
    }
    // claude mcp add exits non-zero if the server already exists; treat as success
    if (!(err?.stderr as string | undefined)?.includes('already exists')) {
      throw err;
    }
  }
}

async function setupConfigFile(path: string, apiKey: string): Promise<'created' | 'updated'> {
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, 'utf8');
    existing = JSON.parse(raw);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  const alreadyPresent = 'genfire' in mcpServers;

  mcpServers['genfire'] = {
    transport: {
      type: 'http',
      url: MCP_SERVER_URL,
      headers: { Authorization: `Bearer ${apiKey}` }
    }
  };

  existing.mcpServers = mcpServers;

  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(existing, null, 2) + '\n', 'utf8');

  return alreadyPresent ? 'updated' : 'created';
}

export function registerMcpCommand(program: Command): void {
  const mcp = program.command('mcp').description('Manage GenFire MCP server configuration');

  mcp
    .command('setup')
    .description('Configure the GenFire MCP server in your AI client using your stored credentials')
    .option('--client <client>', 'Target client: claude-code (default), claude-desktop, or cursor')
    .option('--api-key <key>', 'Use this API key instead of the stored credential')
    .action(async (options: { client?: string; apiKey?: string }) => {
      const client = (options.client ?? 'claude-code') as McpClient;
      if (!['claude-code', 'claude-desktop', 'cursor'].includes(client)) {
        throw new CliError(
          `Unknown client "${client}". Choose: claude-code, claude-desktop, cursor`,
          'invalid_client'
        );
      }

      let apiKey: string;
      if (options.apiKey) {
        apiKey = options.apiKey.trim();
      } else {
        const resolved = await resolveApiKey();
        if (!resolved) {
          throw new CliError(
            'Not authenticated. Run `genfire auth login` first.',
            'not_authenticated'
          );
        }
        apiKey = resolved.apiKey;
      }

      if (client === 'claude-code') {
        await setupClaudeCode(apiKey);
        printResult(
          { ok: true, client, url: MCP_SERVER_URL },
          () => {
            process.stderr.write(
              `${green('GenFire MCP configured for Claude Code.')}\n` +
              `${dim('Server:')} ${cyan(MCP_SERVER_URL)}\n` +
              `${dim('Run')} ${bold('/mcp')} ${dim('in Claude Code to confirm 22 tools are connected.')}\n`
            );
          }
        );
        return;
      }

      const configPath = client === 'cursor' ? cursorConfigPath() : claudeDesktopConfigPath();
      const action = await setupConfigFile(configPath, apiKey);

      printResult(
        { ok: true, client, config_path: configPath, action, url: MCP_SERVER_URL },
        () => {
          process.stderr.write(
            `${green(`GenFire MCP ${action === 'created' ? 'added to' : 'updated in'} ${client === 'cursor' ? 'Cursor' : 'Claude Desktop'}`)}\n` +
            `${dim('Config:')} ${configPath}\n` +
            `${dim('Server:')} ${cyan(MCP_SERVER_URL)}\n` +
            `${yellow('Restart')} ${client === 'cursor' ? 'Cursor' : 'Claude Desktop'} ${dim('then check MCP tools are available.')}\n`
          );
        }
      );
    });
}
