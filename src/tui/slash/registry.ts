import type { GenFireClient } from '@genfire/sdk';
import { useTuiStore, AccountSnapshot } from '../store.js';

export interface SlashContext {
  args: string[];
  rawArgs: string;
  client: GenFireClient | null;
  account: AccountSnapshot | null;
  log: (text: string, kind?: 'output' | 'info' | 'success' | 'error' | 'system') => void;
}

export interface SlashCommand {
  name: string;
  summary: string;
  usage?: string;
  requiresAuth?: boolean;
  /** When true, no log entry is auto-appended for the input itself. */
  silent?: boolean;
  execute: (ctx: SlashContext) => Promise<void>;
}

const registry = new Map<string, SlashCommand>();

export function registerSlash(command: SlashCommand): void {
  registry.set(command.name, command);
}

export function getSlash(name: string): SlashCommand | undefined {
  return registry.get(name);
}

export function listSlash(): SlashCommand[] {
  return Array.from(registry.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function suggestSlash(prefix: string): string[] {
  const lower = prefix.toLowerCase().replace(/^\//, '');
  return listSlash()
    .filter((cmd) => cmd.name.startsWith(lower))
    .map((cmd) => cmd.name);
}

/**
 * Splits an input line into command name + remaining argv. Strips the leading
 * slash. Quotes are honored so prompts with spaces stay intact.
 */
export function parseSlashLine(line: string): { name: string; args: string[]; rawArgs: string } {
  const trimmed = line.trim();
  const stripped = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const firstSpace = stripped.search(/\s/);
  const name = firstSpace === -1 ? stripped : stripped.slice(0, firstSpace);
  const rawArgs = firstSpace === -1 ? '' : stripped.slice(firstSpace + 1).trim();

  const args: string[] = [];
  let buffer = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const ch = rawArgs[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && rawArgs[i + 1] === quote) {
        buffer += quote;
        i += 1;
      } else {
        buffer += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buffer.length > 0) {
        args.push(buffer);
        buffer = '';
      }
      continue;
    }
    buffer += ch;
  }
  if (buffer.length > 0) args.push(buffer);

  return { name: name.toLowerCase(), args, rawArgs };
}

export async function dispatchSlash(line: string): Promise<void> {
  const store = useTuiStore.getState();
  const { name, args, rawArgs } = parseSlashLine(line);
  if (!name) return;

  const command = registry.get(name);
  const log = (text: string, kind: 'output' | 'info' | 'success' | 'error' | 'system' = 'output') =>
    store.appendLog({ kind, text });

  if (!command) {
    log(`Unknown command: /${name}. Type /help for the list of commands.`, 'error');
    return;
  }

  if (command.requiresAuth && !store.client) {
    log('Authentication required. Run /login to sign in (or set GENFIRE_API_KEY).', 'error');
    return;
  }

  store.setBusy(true);
  try {
    await command.execute({
      args,
      rawArgs,
      client: store.client,
      account: store.account,
      log
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`Error: ${detail}`, 'error');
  } finally {
    store.setBusy(false);
  }
}
