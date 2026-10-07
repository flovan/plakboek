import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnOptions = {
  cwd?: string;
  /** `inherit` shows the child's output; `ignore` discards it. */
  stdio: 'inherit' | 'ignore';
};

export type SpawnResult = {
  /** Exit status, or null when the process could not run or was killed. */
  status: number | null;
  /** The command is not installed or not on PATH. */
  notFound: boolean;
};

export type Spawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => Promise<SpawnResult>;

/**
 * Run a child process with an argument array. Nothing derived from a prompt
 * answer is ever part of the command or its arguments; only `cwd` carries the
 * project directory.
 */
export const spawnProcess: Spawner = (command, args, options) =>
  new Promise((resolve) => {
    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio,
      // pnpm is a .cmd shim on Windows, which needs a shell to start. The
      // command and arguments are fixed strings, so no shell string is ever
      // built from an answer.
      shell: process.platform === 'win32',
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ status: null, notFound: error.code === 'ENOENT' });
    });
    child.once('close', (code) => {
      resolve({ status: code, notFound: false });
    });
  });
