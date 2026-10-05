/**
 * Spawns the built `plakboek` bin the way an operator's shell or a deploy
 * step does: a real process, its own environment and working directory, and
 * stdin as a pipe (so it is never a TTY). Nothing is inherited from the test
 * process except `PATH`, so a stray `DATABASE_URL` cannot leak in.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACKAGE_DIR = resolve(import.meta.dirname, '..', '..');

export const CLI_ENTRY = join(PACKAGE_DIR, 'dist', 'cli.js');

export type CliResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunCliOptions = {
  /** The whole environment of the process, apart from `PATH`. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Written to stdin, which is then closed. */
  readonly stdin?: string;
};

/** Runs `node dist/cli.js <args>` and collects its exit code and output. */
export function runCli(
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      'packages/core/dist/cli.js is missing: run `pnpm --filter @plakboek/core run build` before the integration suite',
    );
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: options.cwd ?? PACKAGE_DIR,
      env: { PATH: process.env.PATH ?? '', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {
      // The process may exit before reading stdin; that is not a harness error.
    });
    child.stdin.end(options.stdin ?? '');
  });
}

/** Lines of `output` that start with `prefix`. */
export function linesStartingWith(
  output: string,
  prefix: string,
): readonly string[] {
  return output.split('\n').filter((line) => line.startsWith(prefix));
}
