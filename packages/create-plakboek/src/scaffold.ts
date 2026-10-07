import { constants } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Whole placeholder tokens a template may contain. Quotes and brackets are
 * part of the token, so a replacement is always a complete JSON literal and
 * never a fragment spliced into surrounding source.
 */
export const PLACEHOLDER_TOKENS = [
  "'__SITE_NAME__'",
  "'__DEFAULT_LOCALE__'",
  "['__LOCALES__']",
  "'__TIMEZONE__'",
  '"__PACKAGE_NAME__"',
  '"__PLAKBOEK_VERSION__"',
] as const;

/** The only files whose content is substituted; everything else is copied. */
export const SUBSTITUTED_FILES = [
  'package.json',
  'plakboek.config.ts',
] as const;

export type ScaffoldAnswers = {
  packageName: string;
  siteName: string;
  defaultLocale: string;
  /** Locales besides the default one; duplicates and the default are ignored. */
  additionalLocales: string[];
  timezone: string;
};

export type ScaffoldOptions = {
  templateDir: string;
  targetDir: string;
  answers: ScaffoldAnswers;
  /** The CLI's own version; every `@plakboek/*` dependency is pinned to it. */
  version: string;
};

type PlannedFile = { destination: string; data: Buffer | string; mode: number };

const UNRESOLVED_TOKEN = /__[A-Z][A-Z_]*__/g;
const TOKEN_PATTERN = new RegExp(
  PLACEHOLDER_TOKENS.map((token) =>
    token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|'),
  'g',
);

/**
 * Resolve a relative path under `base`, refusing anything that would land
 * outside it.
 */
export function resolveInside(base: string, relativePath: string): string {
  const root = resolve(base);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Refusing to write "${relativePath}" outside ${root}.`);
  }
  return resolved;
}

function replacements(
  answers: ScaffoldAnswers,
  version: string,
): Record<(typeof PLACEHOLDER_TOKENS)[number], string> {
  const locales = [
    ...new Set([answers.defaultLocale, ...answers.additionalLocales]),
  ];
  return {
    "'__SITE_NAME__'": JSON.stringify(answers.siteName),
    "'__DEFAULT_LOCALE__'": JSON.stringify(answers.defaultLocale),
    "['__LOCALES__']": JSON.stringify(locales),
    "'__TIMEZONE__'": JSON.stringify(answers.timezone),
    '"__PACKAGE_NAME__"': JSON.stringify(answers.packageName),
    '"__PLAKBOEK_VERSION__"': JSON.stringify(version),
  };
}

/**
 * Replace every whole token in one pass, so text inside an answer is never
 * scanned again. A token-shaped string that is not a known token (a typo in
 * the template) is an error; the check runs on the template text with the
 * known tokens removed, so an answer that happens to look like a token is
 * plain data and never trips it.
 */
function substitute(
  relativePath: string,
  text: string,
  table: Record<string, string>,
): string {
  const leftover = text.replace(TOKEN_PATTERN, '').match(UNRESOLVED_TOKEN);
  if (leftover !== null) {
    throw new Error(
      `Template file ${relativePath} holds an unresolved placeholder: ${leftover[0]}`,
    );
  }
  return text.replace(TOKEN_PATTERN, (token) => table[token] ?? token);
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full)));
    } else if (entry.isFile()) {
      found.push(full);
    } else {
      throw new Error(`Template entry ${full} is not a regular file.`);
    }
  }
  return found.sort();
}

function destinationName(relativePath: string): string {
  // npm packing drops dotfile ignore files, so the template stores
  // `_gitignore` and the project gets `.gitignore`.
  return relativePath
    .split(sep)
    .map((part) => (part === '_gitignore' ? '.gitignore' : part))
    .join(sep);
}

/**
 * Copy the template into `targetDir` and return the number of files written.
 *
 * Every file's content is prepared and every destination is checked before the
 * first byte is written, so a bad template writes nothing. Files are created
 * exclusively (`wx`): an existing file is never overwritten, and a failure
 * part-way keeps what was written rather than deleting anything.
 */
export async function scaffoldProject(
  options: ScaffoldOptions,
): Promise<number> {
  const { templateDir, targetDir, answers, version } = options;
  const table = replacements(answers, version);
  const substituted = new Set<string>(SUBSTITUTED_FILES);

  const planned: PlannedFile[] = [];
  for (const source of await walk(templateDir)) {
    const relativePath = relative(templateDir, source);
    const info = await lstat(source);
    const bytes = await readFile(source);
    const data = substituted.has(relativePath.split(sep).join('/'))
      ? substitute(relativePath, bytes.toString('utf8'), table)
      : bytes;
    planned.push({
      destination: resolveInside(targetDir, destinationName(relativePath)),
      data,
      mode: info.mode & 0o777,
    });
  }

  await mkdir(targetDir, { recursive: true });
  for (const file of planned) {
    await mkdir(dirname(file.destination), { recursive: true });
    await writeFile(file.destination, file.data, {
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode: file.mode,
    });
  }
  return planned.length;
}
