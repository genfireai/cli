import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface LoopbackResult {
  /**
   * The verification_url that was opened in the browser. The CLI flow doesn't
   * actually use the loopback for the PKCE redirect (the dashboard handles
   * the approval), but we keep a simple status server that confirms when the
   * user has returned, in case we want to support browser→CLI redirect later.
   */
  closed: boolean;
}

/**
 * Spins up a tiny HTTP listener on a random localhost port that simply serves
 * a "you can close this tab" page when hit. We don't need it for the current
 * PKCE-via-polling flow (the dashboard page is the redirect target), but it's
 * here as a no-op placeholder so a future redirect-based flow can plug in
 * without changing the CLI surface. Returns the chosen URL and a stop fn.
 */
export async function startLoopback(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family: system-ui; padding: 2rem;">Genfire CLI is listening. You can close this tab.</body></html>');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/`;

  const stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  return { url, stop };
}
