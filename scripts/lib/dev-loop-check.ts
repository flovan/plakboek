// Development-loop proof for a scaffolded project, run against a LIVE
// `pnpm dev` server. Plain TypeScript run by Node's type stripping:
//
//   node scripts/lib/dev-loop-check.ts <base url> <site dir>
//
// It checks that the page and its stylesheet are served in development, then
// edits a block and a template inside <site dir>, waits for the `full-reload`
// message on Vite's HMR websocket after each edit, and confirms the next
// response shows the change. Both files are restored, and the restore is
// confirmed the same way. Edits happen only in <site dir>, a throwaway
// project; never run this against a checkout you care about.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const RELOAD_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_MS = 5_000;
// Vite can report one file change more than once; let the burst finish before
// the next edit so one edit's message is never mistaken for another's.
const QUIET_PERIOD_MS = 750;

const [baseUrlArgument, siteDirArgument] = process.argv.slice(2);
if (baseUrlArgument === undefined || siteDirArgument === undefined) {
  console.error('usage: dev-loop-check.ts <base url> <site dir>');
  process.exit(2);
}
const baseUrl = baseUrlArgument.replace(/\/+$/, '');
const siteDir = siteDirArgument;

function log(message: string): void {
  console.log(`  dev-loop: ${message}`);
}

async function fetchText(
  path: string,
): Promise<{ status: number; contentType: string; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text: await response.text(),
  };
}

/** Fetches `/` until `accept` holds for the page, or fails after a timeout. */
async function pageEventually(
  accept: (html: string) => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  for (;;) {
    const page = await fetchText('/');
    if (page.status === 200 && accept(page.text)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `GET / did not ${description} within ${PAGE_TIMEOUT_MS / 1000} seconds (last status ${page.status})`,
      );
    }
    await sleep(250);
  }
}

type ReloadSocket = {
  /** Start counting from now: only messages after this call satisfy a wait. */
  mark(): void;
  waitForReload(): Promise<void>;
  close(): void;
};

async function openReloadSocket(): Promise<ReloadSocket> {
  const client = await fetchText('/@vite/client');
  const token = /const wsToken = "([^"]+)"/.exec(client.text)?.[1];
  if (client.status !== 200 || token === undefined) {
    throw new Error('/@vite/client did not expose the HMR websocket token');
  }
  const url = `${baseUrl.replace(/^http/, 'ws')}/?token=${encodeURIComponent(token)}`;

  let socket: WebSocket;
  try {
    socket = new WebSocket(url, 'vite-hmr');
  } catch (error) {
    throw new Error(
      `the global WebSocket refused the vite-hmr subprotocol (${String(error)}); use the ws package instead`,
      { cause: error },
    );
  }

  let reloads = 0;
  let baseline = 0;
  socket.addEventListener('message', (event: MessageEvent) => {
    if (
      typeof event.data === 'string' &&
      event.data.includes('"type":"full-reload"')
    ) {
      reloads += 1;
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the HMR websocket did not open in time')),
      OPEN_TIMEOUT_MS,
    );
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(
        new Error(
          'the HMR websocket was refused; check the token and the vite-hmr subprotocol',
        ),
      );
    });
  });

  return {
    mark() {
      baseline = reloads;
    },
    async waitForReload() {
      const deadline = Date.now() + RELOAD_TIMEOUT_MS;
      while (reloads <= baseline) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out after ${RELOAD_TIMEOUT_MS / 1000} seconds waiting for a full-reload message`,
          );
        }
        await sleep(50);
      }
      await sleep(QUIET_PERIOD_MS);
    },
    close() {
      socket.close();
    },
  };
}

type Edit = {
  /** File inside the site directory. */
  file: string;
  /** Text the file must contain; the marker attribute is added after it. */
  anchor: string;
  marker: string;
  label: string;
};

/** Edits a file, proves the reload and the change, then proves the restore. */
async function proveEdit(socket: ReloadSocket, edit: Edit): Promise<void> {
  const path = join(siteDir, edit.file);
  const original = await readFile(path, 'utf8');
  if (!original.includes(edit.anchor)) {
    throw new Error(`${edit.file} does not contain ${edit.anchor}`);
  }
  const attribute = `data-proof="${edit.marker}"`;
  const edited = original.replace(edit.anchor, `${edit.anchor} ${attribute}`);

  try {
    socket.mark();
    await writeFile(path, edited);
    await socket.waitForReload();
    log(`${edit.label}: full-reload received after editing ${edit.file}`);
    await pageEventually(
      (html) => html.includes(attribute),
      `show ${attribute}`,
    );
    log(`${edit.label}: the next response shows ${attribute}`);
  } finally {
    // Restore even when an assertion above failed.
    socket.mark();
    await writeFile(path, original);
  }

  await socket.waitForReload();
  await pageEventually(
    (html) => !html.includes(attribute),
    `drop ${attribute} after the restore`,
  );
  log(`${edit.label}: ${edit.file} restored`);
}

async function main(): Promise<void> {
  const home = await fetchText('/');
  if (home.status !== 200) {
    throw new Error(`GET / answered ${home.status}, expected 200`);
  }
  if (!home.text.includes('Hello world')) {
    throw new Error("GET / does not contain 'Hello world'");
  }
  if (!home.text.includes('/@vite/client')) {
    throw new Error('GET / does not load /@vite/client in development');
  }
  const href = /<link rel="stylesheet" href="([^"]+)"/.exec(home.text)?.[1];
  if (href === undefined) {
    throw new Error('GET / has no stylesheet link');
  }
  if (!href.endsWith('?direct')) {
    throw new Error(
      `the development stylesheet link must end in ?direct, got ${href}`,
    );
  }
  const stylesheet = await fetchText(href);
  if (stylesheet.status !== 200) {
    throw new Error(`GET ${href} answered ${stylesheet.status}`);
  }
  if (!stylesheet.contentType.toLowerCase().includes('text/css')) {
    throw new Error(
      `GET ${href} answered Content-Type ${stylesheet.contentType}, expected text/css`,
    );
  }
  if (!/1d4ed8/i.test(stylesheet.text)) {
    throw new Error(`GET ${href} does not carry the theme's accent colour`);
  }
  log(`page and stylesheet served in development (${href})`);

  const socket = await openReloadSocket();
  try {
    await proveEdit(socket, {
      file: 'blocks/heading.tsx',
      anchor: '<h1',
      marker: 'block',
      label: 'block edit',
    });
    await proveEdit(socket, {
      file: 'app/site/header.tsx',
      anchor: '<header',
      marker: 'header',
      label: 'template edit',
    });
  } finally {
    socket.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`FATAL: dev-loop-check: ${(error as Error).message}`);
  process.exit(1);
}
