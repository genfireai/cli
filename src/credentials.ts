import { readFile, writeFile, mkdir, chmod, unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const KEYTAR_SERVICE = 'genfire-cli';
const KEYTAR_ACCOUNT = 'default';

export interface StoredCredentials {
  apiKey: string;
  label?: string;
  scopes?: string[];
  baseUrl?: string;
  storedAt?: string;
}

interface KeytarLike {
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  getPassword: (service: string, account: string) => Promise<string | null>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
}

let keytarPromise: Promise<KeytarLike | null> | null = null;

async function loadKeytar(): Promise<KeytarLike | null> {
  if (process.env.GENFIRE_DISABLE_KEYTAR === '1') return null;
  if (!keytarPromise) {
    keytarPromise = import('keytar')
      .then((mod) => (mod as unknown as { default?: KeytarLike }).default ?? (mod as unknown as KeytarLike))
      .catch(() => null);
  }
  return keytarPromise;
}

function fallbackDir(): string {
  if (process.env.GENFIRE_CONFIG_DIR) return process.env.GENFIRE_CONFIG_DIR;
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'genfire');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'genfire');
}

function fallbackPath(): string {
  return join(fallbackDir(), 'credentials.json');
}

async function readFallback(): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile(fallbackPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.apiKey === 'string') return parsed as StoredCredentials;
    return null;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeFallback(creds: StoredCredentials): Promise<void> {
  await mkdir(fallbackDir(), { recursive: true });
  const path = fallbackPath();
  await writeFile(path, JSON.stringify(creds, null, 2) + '\n', 'utf8');
  if (platform() !== 'win32') {
    await chmod(path, 0o600);
  }
}

async function clearFallback(): Promise<void> {
  try {
    await unlink(fallbackPath());
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

export async function saveCredentials(creds: StoredCredentials): Promise<{ backend: 'keychain' | 'file'; path?: string }> {
  const stored: StoredCredentials = {
    ...creds,
    storedAt: creds.storedAt || new Date().toISOString()
  };

  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, JSON.stringify(stored));
      await clearFallback();
      return { backend: 'keychain' };
    } catch {
      // Fall through to file fallback if keychain write fails (e.g. no libsecret on Linux).
    }
  }

  await writeFallback(stored);
  return { backend: 'file', path: fallbackPath() };
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.apiKey === 'string') return parsed as StoredCredentials;
      }
    } catch {
      // Fall through to file
    }
  }
  return readFallback();
}

export async function deleteCredentials(): Promise<void> {
  const keytar = await loadKeytar();
  if (keytar) {
    try { await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT); } catch {}
  }
  await clearFallback();
}

export function getFallbackPath(): string {
  return fallbackPath();
}

export async function isUsingKeychain(): Promise<boolean> {
  const keytar = await loadKeytar();
  if (!keytar) return false;
  try {
    const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    return raw !== null;
  } catch {
    return false;
  }
}
