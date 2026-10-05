#!/usr/bin/env node
/**
 * The `plakboek` bin. Each command lives in its own module and is imported
 * only when it runs, so `--version`, `--help` and a usage error never load the
 * database or host code. Exit codes: 0 success, 1 failure, 2 bad usage.
 */
import { readFileSync } from 'node:fs';
import { loadEnvFile } from './env-file.js';
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
  messageOf,
  printError,
  printErrorLine,
  printLine,
} from './output.js';

const USAGE = `Usage: plakboek <command> [options]

Commands:
  migrate    Apply the core database migrations

Run plakboek <command> --help for a command's options.
Run plakboek --version to print the installed version.`;

type Command = (argv: readonly string[]) => Promise<number>;

const COMMANDS: Readonly<Record<string, () => Promise<Command>>> = {
  migrate: async () => (await import('./migrate.js')).runMigrateCommand,
};

function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const version =
    typeof manifest === 'object' && manifest !== null
      ? Reflect.get(manifest, 'version')
      : undefined;
  return typeof version === 'string' ? version : 'unknown';
}

async function main(argv: readonly string[]): Promise<number> {
  const [first, ...rest] = argv;

  if (first === '--version' || first === '-v') {
    printLine(packageVersion());
    return EXIT_OK;
  }
  if (first === '--help' || first === '-h') {
    printLine(USAGE);
    return EXIT_OK;
  }
  if (first === undefined) {
    printErrorLine(USAGE);
    return EXIT_USAGE;
  }

  const load = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  if (load === undefined) {
    printError(`Unknown command "${first}".`);
    printErrorLine(USAGE);
    return EXIT_USAGE;
  }

  loadEnvFile();
  try {
    return await (
      await load()
    )(rest);
  } catch (error) {
    if (error instanceof UsageError) {
      printError(error.message);
      printErrorLine(USAGE);
      return EXIT_USAGE;
    }
    printError(messageOf(error));
    return EXIT_FAILURE;
  }
}

process.exitCode = await main(process.argv.slice(2));
