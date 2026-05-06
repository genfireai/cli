/**
 * Single source of truth for the installed CLI version. Bumped per release.
 * Other modules import VERSION from here instead of duplicating the literal.
 */
export const VERSION = '0.3.2';

/**
 * Best-effort check against npm to warn if the installed CLI is behind the
 * latest published version. Returns null on any error — never throws, never
 * blocks. Intended to be called after a successful `auth login` so users on
 * stale builds know they're missing newer features (e.g. wider scope sets,
 * picker UX, bug fixes).
 */
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@genfire/cli/latest';
const TIMEOUT_MS = 3000;

export interface VersionCheckResult {
  installed: string;
  latest: string;
  isOutdated: boolean;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export async function checkLatestVersion(installedVersion: string): Promise<VersionCheckResult | null> {
  if (!installedVersion) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return null;

    const body = await response.json() as { version?: string };
    const latest = typeof body.version === 'string' ? body.version : null;
    if (!latest) return null;

    return {
      installed: installedVersion,
      latest,
      isOutdated: compareVersions(installedVersion, latest) < 0
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
