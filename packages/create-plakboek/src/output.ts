export type Style = {
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
};

/** Colour only when stdout is a TTY and NO_COLOR is unset. */
export function createStyle(options: {
  isTTY: boolean;
  env: Record<string, string | undefined>;
}): Style {
  const noColor = options.env.NO_COLOR;
  const enabled = options.isTTY && (noColor === undefined || noColor === '');
  const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39) };
}

/** `Error: message`, with the label in red where colour is on. */
export function errorLine(style: Style, message: string): string {
  return `${style.red('Error:')} ${message}\n`;
}

/** A status line such as `Created ...`; the leading word is bold. */
export function statusLine(style: Style, word: string, rest: string): string {
  return `${style.bold(word)}${rest}\n`;
}

/** Quote a path for a copy-and-paste shell command only when it needs it. */
export function shellPath(path: string): string {
  if (/^[A-Za-z0-9_./~@%+=:,-]+$/.test(path)) return path;
  return `"${path.replace(/(["\\$`])/g, '\\$1')}"`;
}

export type NextStepsOptions = {
  dir: string;
  skipInstall: boolean;
};

/** The final block of the success output (UI-SPEC S3). */
export function nextSteps(style: Style, options: NextStepsOptions): string {
  const lines = [
    style.bold('Next steps:'),
    `  cd ${shellPath(options.dir)}`,
    ...(options.skipInstall ? ['  pnpm install'] : []),
    '  cp .env.example .env',
    '  pnpm --silent secret >> .env',
    '  docker compose up -d postgres',
    '  pnpm plakboek migrate',
    '  pnpm dev',
    '',
    'Then open the URL that pnpm dev prints, followed by /cms/setup, to create the',
    'first superadmin. To do it from the terminal instead:',
    '  pnpm plakboek bootstrap --name "Your Name" --email you@example.com',
  ];
  return `${lines.join('\n')}\n`;
}
