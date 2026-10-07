/**
 * `plakboek bootstrap`: the headless first-superadmin surface (D-08). It calls
 * the same `bootstrapInstallation` as the setup page, so the first user and
 * the seeded home page are created identically from the terminal. It is the
 * operator's way around the open web setup window (D-09).
 *
 * The password is never a flag value (it would land in shell history and
 * process lists): it comes from stdin with `--password-stdin`, from
 * `PLAKBOEK_BOOTSTRAP_PASSWORD`, or from a hidden prompt on a TTY.
 */
import { PASSWORD_MIN_LENGTH } from '@plakboek/auth';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import {
  BootstrapValidationError,
  DatabaseNotReadyError,
  InstallationNotEmptyError,
  bootstrapInstallation,
  validateBootstrapInput,
  type BootstrapIssue,
} from '../runtime/bootstrap.js';
import { closeAllDbs } from '../runtime/db.js';
import {
  PlakboekEnvError,
  readRuntimeEnv,
  type RuntimeEnv,
} from '../runtime/env.js';
import { createRuntime } from '../runtime/runtime.js';
import { HostConfigError, loadHostConfig } from './load-config.js';
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
  connectionSecrets,
  messageOf,
  oneLine,
  parseFlags,
  printError,
  printLine,
} from './output.js';

export const BOOTSTRAP_HELP = `Usage: plakboek bootstrap [--name <name>] [--email <address>] [--password-stdin]
                          [--config <path>]

Creates the first superadmin and publishes the seed home page. Only runs on an
installation with no users. Run plakboek migrate first.

The password is never a flag. Provide it on stdin with --password-stdin, in
PLAKBOEK_BOOTSTRAP_PASSWORD, or at the hidden prompt in a terminal.

Options:
  --name <name>        The superadmin's name
  --email <address>    The superadmin's email address
  --password-stdin     Read the password from stdin
  --config <path>      The host config (default ./plakboek.config.ts)
  -h, --help           Show this help`;

const NON_INTERACTIVE = 'when input is not interactive';

/** Asks one question on the terminal; `hidden` suppresses the echo. */
function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const sink = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    process.stdout.write(`${question}: `);
    const lines = createInterface({
      input: process.stdin,
      output: hidden ? sink : process.stdout,
      terminal: true,
    });
    let answered = false;
    lines.question('', (answer) => {
      answered = true;
      lines.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    lines.on('close', () => {
      if (!answered) reject(new UsageError('Input was cancelled.'));
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Exactly one trailing newline (LF or CRLF) is not part of the password. */
function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, '');
}

async function resolvePassword(
  fromStdin: boolean,
  env: NodeJS.ProcessEnv,
  interactive: boolean,
): Promise<string> {
  if (fromStdin) return stripTrailingNewline(await readStdin());
  const fromEnv = env.PLAKBOEK_BOOTSTRAP_PASSWORD;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (!interactive) {
    throw new UsageError(
      `--password-stdin or PLAKBOEK_BOOTSTRAP_PASSWORD is required ${NON_INTERACTIVE}.`,
    );
  }
  const password = await ask('Password', true);
  const confirmation = await ask('Confirm password', true);
  if (password !== confirmation) {
    throw new UsageError('The two passwords do not match.');
  }
  return password;
}

/** The copy for one field problem; the password rule has its own wording. */
function issueCopy(issue: BootstrapIssue): string {
  return issue.field === 'password'
    ? `The password must be at least ${String(PASSWORD_MIN_LENGTH)} characters.`
    : issue.message;
}

function reportIssues(issues: readonly BootstrapIssue[]): number {
  for (const issue of issues) printError(issueCopy(issue));
  return EXIT_USAGE;
}

export async function runBootstrapCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { values } = parseFlags(argv, {
    name: { type: 'string' },
    email: { type: 'string' },
    'password-stdin': { type: 'boolean' },
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    printLine(BOOTSTRAP_HELP);
    return EXIT_OK;
  }

  const interactive = process.stdin.isTTY === true;
  let name = values.name;
  if (name === undefined) {
    if (!interactive) {
      throw new UsageError(`--name is required ${NON_INTERACTIVE}.`);
    }
    name = await ask('Name', false);
  }
  let email = values.email;
  if (email === undefined) {
    if (!interactive) {
      throw new UsageError(`--email is required ${NON_INTERACTIVE}.`);
    }
    email = await ask('Email address', false);
  }
  const password = await resolvePassword(
    values['password-stdin'] === true,
    env,
    interactive,
  );

  const issues = validateBootstrapInput({ name, email, password });
  if (issues.length > 0) return reportIssues(issues);

  let runtimeEnv: RuntimeEnv;
  try {
    runtimeEnv = readRuntimeEnv(env);
  } catch (error) {
    if (error instanceof PlakboekEnvError) {
      for (const issue of error.issues) printError(issue.message);
      return EXIT_FAILURE;
    }
    throw error;
  }
  const secrets = [
    password,
    ...connectionSecrets(runtimeEnv.databaseUrl),
    ...(runtimeEnv.smtp?.pass === undefined ? [] : [runtimeEnv.smtp.pass]),
  ];

  try {
    const config = await loadHostConfig(
      values.config ?? './plakboek.config.ts',
    );
    const runtime = createRuntime({ config }, runtimeEnv);
    const result = await bootstrapInstallation(runtime, {
      name,
      email,
      password,
    });
    printLine(`Created superadmin ${result.email}.`);
    if (result.homePublished) {
      printLine(`Published the home page at ${result.homePath}.`);
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof BootstrapValidationError) {
      return reportIssues(error.issues);
    }
    if (error instanceof InstallationNotEmptyError) {
      printError(error.message);
    } else if (error instanceof DatabaseNotReadyError) {
      printError('The database is not ready. Run plakboek migrate first.');
    } else if (error instanceof HostConfigError) {
      printError(error.message);
    } else {
      printError(oneLine(messageOf(error), secrets));
    }
    return EXIT_FAILURE;
  } finally {
    await closeAllDbs();
  }
}
