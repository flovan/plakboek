import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HELP_TEXT, USAGE_LINE, parseCliArgs } from './args.js';
import {
  createStyle,
  errorLine,
  nextSteps,
  statusLine,
  type Style,
} from './output.js';
import { createPrompter, type Prompter } from './prompts.js';
import { scaffoldProject } from './scaffold.js';
import type { Spawner } from './spawn.js';
import {
  defaultSiteName,
  packageNameFromDir,
  parseLocaleList,
  validateDirectory,
  validateLocale,
  validateSiteName,
  type Result,
} from './validate.js';

// The supported floor, 22.22: the generated project's React Router 8 needs it.
const MIN_NODE = { major: 22, minor: 22, label: '22.22' } as const;
const DEFAULT_DIR = 'my-plakboek-site';
const DEFAULT_LOCALE = 'en';
const DEFAULT_LOCALES = 'nl';

export type RunOptions = {
  argv: string[];
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  cwd: string;
  /** `process.versions.node`, with or without a leading `v`. */
  nodeVersion: string;
  spawn: Spawner;
  templateDir: string;
  /** The CLI's own version; the generated manifest pins `@plakboek/*` to it. */
  version: string;
};

/** Raised for an answer that cannot be obtained; carries the exit code. */
class Abort extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

function nodeIsSupported(version: string): boolean {
  const [major = 0, minor = 0] = version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (major !== MIN_NODE.major) return major > MIN_NODE.major;
  return minor >= MIN_NODE.minor;
}

function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function validateTimeZone(value: string): Result<string> {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      message: `"${value}" is not a valid time zone. Use an IANA name such as Europe/Brussels.`,
    };
  }
}

type Answers = {
  dir: string;
  siteName: string;
  defaultLocale: string;
  additionalLocales: string[];
  timezone: string;
};

/**
 * Resolve one answer. A flag value is used when valid; an invalid flag value
 * or a missing one falls back to a prompt on a TTY, to the default under
 * `--yes`, and to a usage error (exit 2) when input is not interactive.
 */
async function resolveAnswer<T>(options: {
  flag: string;
  given: string | undefined;
  defaultValue: string;
  question: string;
  /** What a blank prompt answer means; the default unless stated. */
  blank?: string;
  yes: boolean;
  interactive: boolean;
  prompter: () => Prompter;
  validate: (value: string) => Result<T>;
  report: (message: string) => void;
}): Promise<T> {
  const canPrompt = options.interactive && !options.yes;
  let candidate = options.given;

  if (candidate === undefined && options.yes) {
    candidate = options.defaultValue;
  }

  for (;;) {
    if (candidate === undefined) {
      if (!canPrompt) {
        throw new Abort(
          `${options.flag} is required when input is not interactive.`,
          2,
        );
      }
      const answer = await options.prompter().ask(options.question);
      if (answer === null) {
        throw new Abort('Input ended before every question was answered.', 2);
      }
      candidate =
        answer === '' ? (options.blank ?? options.defaultValue) : answer;
    }
    const checked = options.validate(candidate);
    if (checked.ok) return checked.value;
    if (!canPrompt) throw new Abort(checked.message, 2);
    options.report(checked.message);
    candidate = undefined;
  }
}

export async function run(options: RunOptions): Promise<number> {
  const { stdout, stderr, env, spawn } = options;
  const style: Style = createStyle({ isTTY: stdout.isTTY === true, env });
  const errStyle: Style = createStyle({
    isTTY: (stderr as { isTTY?: boolean }).isTTY === true,
    env,
  });
  const fail = (message: string): void => {
    stderr.write(errorLine(errStyle, message));
  };

  if (!nodeIsSupported(options.nodeVersion)) {
    fail(
      `Plakboek requires Node.js ${MIN_NODE.label} or later (found ${options.nodeVersion.replace(/^v/, '')}).`,
    );
    return 1;
  }

  const parsed = parseCliArgs(options.argv);
  if (!parsed.ok) {
    fail(parsed.message);
    stderr.write(
      `${USAGE_LINE}\nRun create-plakboek --help to see every option.\n`,
    );
    return 2;
  }
  const args = parsed.value;
  if (args.help) {
    stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    stdout.write(`${options.version}\n`);
    return 0;
  }

  const interactive = options.stdin.isTTY === true;
  let prompter: Prompter | undefined;
  const getPrompter = (): Prompter => {
    prompter ??= createPrompter(options.stdin, stdout);
    return prompter;
  };
  const common = {
    yes: args.yes,
    interactive,
    prompter: getPrompter,
    report: fail,
  };

  let answers: Answers;
  let typedDir: string;
  try {
    typedDir = await resolveAnswer({
      ...common,
      flag: '--dir',
      given: args.dir,
      defaultValue: DEFAULT_DIR,
      question: `Project directory (${DEFAULT_DIR}): `,
      validate: (value) => {
        const checked = validateDirectory(resolve(options.cwd, value), value);
        return checked.ok ? { ok: true, value } : checked;
      },
    });
    const siteName = await resolveAnswer({
      ...common,
      flag: '--site-name',
      given: args.siteName,
      defaultValue: defaultSiteName(typedDir),
      question: `Site name (${defaultSiteName(typedDir)}): `,
      validate: validateSiteName,
    });
    const defaultLocale = await resolveAnswer({
      ...common,
      flag: '--locale',
      given: args.locale,
      defaultValue: DEFAULT_LOCALE,
      question: `Default locale (${DEFAULT_LOCALE}): `,
      validate: validateLocale,
    });
    const additionalLocales = await resolveAnswer({
      ...common,
      flag: '--locales',
      given: args.locales,
      defaultValue: DEFAULT_LOCALES,
      // UI-SPEC E8: a blank answer to this prompt means no additional locale;
      // the default applies under --yes.
      blank: '',
      question: 'Additional locales (comma-separated, blank for none): ',
      validate: (value) => parseLocaleList(value, defaultLocale),
    });
    let timezone = systemTimeZone();
    if (args.timezone !== undefined) {
      const checked = validateTimeZone(args.timezone);
      if (!checked.ok) throw new Abort(checked.message, 2);
      timezone = checked.value;
    }
    answers = {
      dir: typedDir,
      siteName,
      defaultLocale,
      additionalLocales,
      timezone,
    };
  } catch (error) {
    if (error instanceof Abort) {
      fail(error.message);
      return error.exitCode;
    }
    throw error;
  } finally {
    prompter?.close();
  }

  const targetDir = resolve(options.cwd, answers.dir);
  const installing = !args.skipInstall;

  if (!existsSync(options.templateDir)) {
    fail(`The starter template was not found at ${options.templateDir}.`);
    return 1;
  }

  if (installing) {
    const probe = await spawn('pnpm', ['--version'], { stdio: 'ignore' });
    if (probe.notFound || probe.status !== 0) {
      fail(
        'pnpm was not found. Install it from https://pnpm.io/installation and run this command again.',
      );
      return 1;
    }
  }

  let fileCount: number;
  try {
    fileCount = await scaffoldProject({
      templateDir: options.templateDir,
      targetDir,
      answers: {
        packageName: packageNameFromDir(targetDir),
        siteName: answers.siteName,
        defaultLocale: answers.defaultLocale,
        additionalLocales: answers.additionalLocales,
        timezone: answers.timezone,
      },
      version: options.version,
    });
  } catch (error) {
    // Whatever was written stays; nothing is ever deleted.
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  }
  stdout.write(
    statusLine(
      style,
      'Created',
      ` ${answers.dir} from the Plakboek starter (${fileCount} files)`,
    ),
  );

  const git = await spawn('git', ['init', '--quiet'], {
    cwd: targetDir,
    stdio: 'ignore',
  });
  if (git.notFound) {
    stdout.write('Skipped git init (git was not found)\n');
  } else if (git.status !== 0) {
    stdout.write('Skipped git init (git init failed)\n');
  } else {
    stdout.write('Initialised a git repository\n');
  }

  if (installing) {
    stdout.write(statusLine(style, 'Installing', ' dependencies with pnpm'));
    const install = await spawn('pnpm', ['install'], {
      cwd: targetDir,
      stdio: 'inherit',
    });
    if (install.status !== 0) {
      fail(
        `Installing dependencies failed. The project was created in ${answers.dir}; run pnpm install there to retry.`,
      );
      return 1;
    }
    // Put the substituted JSON literals into the project's own formatter
    // style. Cosmetic, so a failure only warns.
    const format = await spawn('pnpm', ['run', 'format'], {
      cwd: targetDir,
      stdio: 'ignore',
    });
    if (format.status !== 0) {
      stdout.write(
        'Warning: pnpm run format did not finish; run it in the project to tidy the generated files.\n',
      );
    }
  }

  stdout.write(statusLine(style, 'Done', `. ${answers.siteName} is ready.`));
  stdout.write(
    `\n${nextSteps(style, { dir: answers.dir, skipInstall: !installing })}`,
  );
  return 0;
}
