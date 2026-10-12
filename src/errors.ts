import { GenFireApiError } from '@genfire/sdk';

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  /** The run an API error belongs to (problem+json `run_id`), when it names one. */
  readonly runId?: string;

  constructor(message: string, code = 'cli_error', exitCode = 1, runId?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    if (runId) this.runId = runId;
  }
}

/**
 * The `run_id` of an API problem+json body. A submit the model refuses
 * AFTER the run was created (a 422 input rejection) names that run, so the user
 * can look it up instead of being told only that "the request failed".
 */
export function apiErrorRunId(err: unknown): string | undefined {
  if (err instanceof CliError) return err.runId;
  if (err instanceof GenFireApiError) {
    const runId = (err.payload as { run_id?: unknown } | undefined)?.run_id;
    return typeof runId === 'string' && runId.trim() ? runId.trim() : undefined;
  }
  return undefined;
}

const SCOPE_HINT =
  'This token was issued without that scope. Run `genfire auth login` to re-authenticate with the current scope set.';

/**
 * What the CLI prints for an error, as lines (no trailing newlines) plus the
 * exit code. Pure, so the wording is testable without exiting the process.
 */
export function formatError(err: unknown): { lines: string[]; exitCode: number } {
  if (err instanceof CliError || err instanceof GenFireApiError) {
    const runId = apiErrorRunId(err);
    const lines = runId
      ? [`Run ${runId} failed: ${err.message} (${err.code})`, `Details: genfire runs get ${runId}`]
      : [err instanceof CliError
          ? `Error (${err.code}): ${err.message}`
          : `API error ${err.status} (${err.code}): ${err.message}`];
    // Tokens are minted with the scope set the CLI requested at login time, so
    // a token issued by an older CLI lacks scopes newer commands need
    // (webhooks, social, …). Re-authenticating re-mints it with the current
    // defaults. Commands on `publicApiRequest` (endpoints the pinned SDK lacks)
    // surface API errors as CliError, so this applies to both.
    if (err.code === 'insufficient_scope') lines.push(SCOPE_HINT);
    return { lines, exitCode: err instanceof CliError ? err.exitCode : 1 };
  }
  if (err instanceof Error) return { lines: [`Error: ${err.message}`], exitCode: 1 };
  return { lines: [`Unknown error: ${String(err)}`], exitCode: 1 };
}
