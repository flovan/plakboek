/**
 * The terminal contract shared by every `plakboek` command: plain text, bold,
 * dim and red only on a TTY without `NO_COLOR`, errors on stderr prefixed
 * `Error: `, and exit codes 0 (success), 1 (failure) and 2 (bad usage).
 */
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Bad usage: an unknown flag or command, a malformed value, a missing
 * required value in a non-interactive run. The command exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function colourEnabled(stream: NodeJS.WriteStream): boolean {
  return stream.isTTY && process.env.NO_COLOR === undefined;
}

function style(stream: NodeJS.WriteStream, code: string, text: string): string {
  return colourEnabled(stream) ? `\u001B[${code}m${text}\u001B[0m` : text;
}

/** One line on stdout. */
export function printLine(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** One line on stdout, dimmed on a TTY (progress and hints). */
export function printDim(line: string): void {
  printLine(style(process.stdout, '2', line));
}

/** `Error: {message}` on stderr; a multi-line message keeps its lines. */
export function printError(message: string): void {
  const prefix = style(process.stderr, '31', 'Error:');
  process.stderr.write(`${prefix} ${message}\n`);
}

/** A plain line on stderr (a hint under an error). */
export function printErrorLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** A message collapsed to one line, with `secrets` replaced. */
export function oneLine(
  message: string,
  secrets: readonly string[] = [],
): string {
  let text = message;
  for (const secret of secrets) {
    if (secret.length > 0) text = text.split(secret).join('<redacted>');
  }
  return text.replaceAll(/\s+/g, ' ').trim();
}

/** The parts of a connection string that must never be printed: the whole
 * string and its password, as written and as decoded. */
export function connectionSecrets(connectionString: string): string[] {
  const secrets = [connectionString];
  try {
    const { password } = new URL(connectionString);
    if (password.length > 0) {
      secrets.push(password, decodeURIComponent(password));
    }
  } catch {
    // Not a URL: the whole string is still redacted.
  }
  return secrets;
}

/** The message of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type Flags<T extends ParseArgsOptionsConfig> = ReturnType<
  typeof parseArgs<{ options: T; strict: true; allowPositionals: true }>
>;

/** `parseArgs` in strict mode, with its errors turned into `UsageError`. */
export function parseFlags<T extends ParseArgsOptionsConfig>(
  argv: readonly string[],
  options: T,
): Flags<T> {
  try {
    return parseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new UsageError(messageOf(error).split('\n')[0] ?? 'Invalid usage.');
  }
}
