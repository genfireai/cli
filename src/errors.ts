export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code = 'cli_error', exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}
