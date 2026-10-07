import { parseArgs } from 'node:util';
import type { Result } from './validate.js';

export type CliArgs = {
  dir?: string;
  siteName?: string;
  locale?: string;
  locales?: string;
  timezone?: string;
  yes: boolean;
  skipInstall: boolean;
  help: boolean;
  version: boolean;
};

export const USAGE_LINE = 'Usage: create-plakboek [dir] [options]';

export const HELP_TEXT = `${USAGE_LINE}

Create a Plakboek host project from the bundled starter.

Options:
  --dir <path>          Project directory (default my-plakboek-site)
  --site-name <name>    Site name, 1 to 200 characters (default: the directory
                        name in Title Case)
  --locale <tag>        Default content locale (default en)
  --locales <list>      Additional locales, comma-separated; blank for none
                        (default nl)
  --timezone <name>     IANA time zone for the site (default: this machine's)
  -y, --yes             Accept every default without asking
  --skip-install        Do not run pnpm install or the formatter
  -h, --help            Show this help
  -v, --version         Show the version

Requires Node.js 22.22 or later and pnpm.
`;

/** Parse argv (without the node and script entries). */
export function parseCliArgs(argv: string[]): Result<CliArgs> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        dir: { type: 'string' },
        'site-name': { type: 'string' },
        locale: { type: 'string' },
        locales: { type: 'string' },
        timezone: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        'skip-install': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const { values, positionals } = parsed;
  const [positional, ...extra] = positionals;
  if (extra.length > 0) {
    return { ok: false, message: `Unexpected argument "${extra[0]}".` };
  }
  const flagDir = typeof values.dir === 'string' ? values.dir : undefined;
  if (
    positional !== undefined &&
    flagDir !== undefined &&
    positional !== flagDir
  ) {
    return {
      ok: false,
      message: 'Give the project directory once, as [dir] or --dir.',
    };
  }

  const text = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

  const args: CliArgs = {
    yes: values.yes === true,
    skipInstall: values['skip-install'] === true,
    help: values.help === true,
    version: values.version === true,
  };
  const dir = positional ?? flagDir;
  if (dir !== undefined) args.dir = dir;
  const siteName = text(values['site-name']);
  if (siteName !== undefined) args.siteName = siteName;
  const locale = text(values.locale);
  if (locale !== undefined) args.locale = locale;
  const locales = text(values.locales);
  if (locales !== undefined) args.locales = locales;
  const timezone = text(values.timezone);
  if (timezone !== undefined) args.timezone = timezone;
  return { ok: true, value: args };
}
