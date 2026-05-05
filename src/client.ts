import { GenFireClient } from '@genfire/sdk';
import { readConfig, resolveApiKey, resolveBaseUrl } from './config.js';
import { CliError } from './errors.js';

export async function createClient(): Promise<GenFireClient> {
  const config = await readConfig();
  const auth = await resolveApiKey();

  if (!auth) {
    throw new CliError(
      'Not authenticated. Run `genfire auth login` or set GENFIRE_API_KEY.',
      'not_authenticated'
    );
  }

  return new GenFireClient({
    apiKey: auth.apiKey,
    baseUrl: resolveBaseUrl(config)
  });
}
