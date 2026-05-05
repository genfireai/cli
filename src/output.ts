import { styleText } from 'node:util';

export interface GlobalFlags {
  json?: boolean;
  noColor?: boolean;
}

let globalFlags: GlobalFlags = {};

export function setGlobalFlags(flags: GlobalFlags): void {
  globalFlags = flags;
  if (flags.noColor) {
    process.env.NO_COLOR = '1';
  }
}

export function getGlobalFlags(): GlobalFlags {
  return globalFlags;
}

function colorEnabled(): boolean {
  if (globalFlags.noColor) return false;
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function color(modifiers: Parameters<typeof styleText>[0], text: string): string {
  if (!colorEnabled()) return text;
  return styleText(modifiers, text);
}

export function dim(text: string): string {
  return color('dim', text);
}

export function bold(text: string): string {
  return color('bold', text);
}

export function red(text: string): string {
  return color('red', text);
}

export function green(text: string): string {
  return color('green', text);
}

export function yellow(text: string): string {
  return color('yellow', text);
}

export function cyan(text: string): string {
  return color('cyan', text);
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function printResult(value: unknown, render: () => void): void {
  if (globalFlags.json) {
    printJson(value);
    return;
  }
  render();
}

export function printTable(rows: Array<Record<string, string | number | undefined | null>>, columns: string[]): void {
  if (rows.length === 0) {
    process.stdout.write(dim('(no rows)\n'));
    return;
  }

  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = col.length;
  }
  for (const row of rows) {
    for (const col of columns) {
      const value = row[col] == null ? '' : String(row[col]);
      if (value.length > widths[col]) widths[col] = value.length;
    }
  }

  const header = columns.map((col) => bold(col.padEnd(widths[col]))).join('  ');
  process.stdout.write(header + '\n');
  process.stdout.write(dim(columns.map((col) => '-'.repeat(widths[col])).join('  ')) + '\n');

  for (const row of rows) {
    const line = columns.map((col) => {
      const value = row[col] == null ? '' : String(row[col]);
      return value.padEnd(widths[col]);
    }).join('  ');
    process.stdout.write(line + '\n');
  }
}
