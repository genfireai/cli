import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { loadCredentials } from './credentials.js';

export interface CliConfig {
  baseUrl?: string;
  workspace?: string;
  defaultImageModel?: string;
  defaultVideoModel?: string;
  outputDir?: string;
}

const DEFAULT_BASE_URL = 'https://api.genfire.ai/v1/';

function configDir(): string {
  if (process.env.GENFIRE_CONFIG_DIR) return process.env.GENFIRE_CONFIG_DIR;
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'genfire');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'genfire');
}

function configPath(): string {
  return join(configDir(), 'config.json');
}

export async function readConfig(): Promise<CliConfig> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as CliConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeConfig(config: CliConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export async function clearConfig(): Promise<void> {
  try {
    await unlink(configPath());
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

export function getConfigPath(): string {
  return configPath();
}

export async function resolveApiKey(): Promise<{ apiKey: string; source: 'env' | 'stored' } | null> {
  const env = process.env.GENFIRE_API_KEY?.trim();
  if (env) return { apiKey: env, source: 'env' };
  const stored = await loadCredentials();
  if (stored?.apiKey) return { apiKey: stored.apiKey, source: 'stored' };
  return null;
}

export function resolveBaseUrl(config: CliConfig): string {
  const env = process.env.GENFIRE_API_BASE_URL?.trim();
  if (env) return env;
  if (config.baseUrl) return config.baseUrl;
  return DEFAULT_BASE_URL;
}
