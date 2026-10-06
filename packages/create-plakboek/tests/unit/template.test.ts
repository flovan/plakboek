import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The bundled starter, read from disk exactly as it is shipped.
const TEMPLATE = join(import.meta.dirname, '..', '..', 'template');
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full)));
    } else {
      out.push(relative(TEMPLATE, full).split(sep).join('/'));
    }
  }
  return out.sort();
}

const read = (path: string): Promise<string> =>
  readFile(join(TEMPLATE, path), 'utf8');

type Manifest = {
  name: string;
  private?: boolean;
  type?: string;
  version?: string;
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function templateManifest(): Promise<Manifest> {
  return JSON.parse(await read('package.json')) as Manifest;
}

/** The workspace catalog as `name -> range`, read from the YAML text. */
async function workspaceCatalog(): Promise<Map<string, string>> {
  const text = await readFile(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const catalog = new Map<string, string>();
  let inCatalog = false;
  for (const line of text.split('\n')) {
    if (/^catalog:\s*$/.test(line)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog && /^\S/.test(line)) break;
    const match = /^ {2}'?([^':]+)'?:\s*(\S+)\s*$/.exec(line);
    if (inCatalog && match?.[1] !== undefined && match[2] !== undefined) {
      catalog.set(match[1], match[2]);
    }
  }
  return catalog;
}

/** The entries of a YAML list under `key`, quotes and comments removed. */
function yamlList(text: string, key: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return [];
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}- '?([^'#\s]+)'?/.exec(line);
    if (match?.[1] === undefined) break;
    entries.push(match[1]);
  }
  return entries;
}

const TOOLING_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'react-router.config.ts',
  'server.ts',
  '.env.example',
  '_gitignore',
  '.oxlintrc.json',
  '.oxfmtrc.json',
];

describe('starter template tooling', () => {
  it('contains every tooling file and no .npmrc', async () => {
    const files = await listFiles(TEMPLATE);
    for (const file of TOOLING_FILES) expect(files).toContain(file);
    expect(files.filter((file) => file.endsWith('.npmrc'))).toEqual([]);
    expect(files).not.toContain('.gitignore');
  });

  it('stores the ignore file as _gitignore and ignores what must stay local', async () => {
    const lines = (await read('_gitignore')).split('\n').map((l) => l.trim());
    for (const entry of ['node_modules', 'build', '.react-router', '.env']) {
      expect(lines.some((line) => line.replace(/^\//, '') === entry)).toBe(
        true,
      );
    }
    expect(lines).toContain('!.env.example');
  });

  it('pins @plakboek/core and @plakboek/render to the CLI version placeholder', async () => {
    const text = await read('package.json');
    expect(text.match(/"__PLAKBOEK_VERSION__"/g)).toHaveLength(2);
    expect(text).toContain('"__PACKAGE_NAME__"');
    const manifest = await templateManifest();
    expect(manifest.dependencies?.['@plakboek/core']).toBe(
      '__PLAKBOEK_VERSION__',
    );
    expect(manifest.dependencies?.['@plakboek/render']).toBe(
      '__PLAKBOEK_VERSION__',
    );
  });

  it('is a private ES module project on Node 22.22 with the monorepo package manager', async () => {
    const manifest = await templateManifest();
    const root = JSON.parse(
      await readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as Manifest;
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
    expect(manifest.engines?.node).toBe('>=22.22');
    expect(manifest.packageManager).toBe(root.packageManager);
  });

  it('declares the developer scripts', async () => {
    const scripts = (await templateManifest()).scripts ?? {};
    expect(scripts.dev).toBe('react-router dev');
    expect(scripts.build).toBe('react-router build');
    expect(scripts.start).toBe('node --env-file-if-exists=.env server.ts');
    expect(scripts.typecheck).toBe('react-router typegen && tsc --noEmit');
    expect(scripts.lint).toBe('oxlint --type-aware --deny-warnings');
    expect(scripts.format).toBe('oxfmt');
    expect(scripts['format:check']).toBe('oxfmt --check');
    expect(scripts.plakboek).toBe('plakboek');
    expect(scripts.secret).toContain('PLAKBOEK_SECRET=');
    expect(scripts.secret).toContain('randomBytes(32)');
    expect(scripts.secret).toContain('base64url');
  });

  it('uses the workspace catalog range for every dependency it shares', async () => {
    const manifest = await templateManifest();
    const catalog = await workspaceCatalog();
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    const shared = Object.entries(declared).filter(([name]) =>
      catalog.has(name),
    );
    // Guard against a parser that silently matches nothing.
    expect(shared.length).toBeGreaterThanOrEqual(15);
    for (const [name, range] of shared) {
      expect({ name, range }).toEqual({ name, range: catalog.get(name) });
    }
  });

  it('declares the host dependency set', async () => {
    const manifest = await templateManifest();
    for (const name of [
      'react',
      'react-dom',
      'react-router',
      '@react-router/node',
      'isbot',
    ]) {
      expect(manifest.dependencies).toHaveProperty(name);
    }
    for (const name of [
      '@react-router/dev',
      'vite',
      'typescript',
      '@types/node',
      '@types/react',
      '@types/react-dom',
      'oxlint',
      'oxlint-tsgolint',
      'oxfmt',
    ]) {
      expect(manifest.devDependencies).toHaveProperty(name);
    }
  });

  it('carries the monorepo supply-chain policy plus first-party age exclusions', async () => {
    const text = await read('pnpm-workspace.yaml');
    const root = await readFile(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
    expect(text).toMatch(/^minimumReleaseAge: 1440$/m);
    expect(yamlList(text, 'minimumReleaseAgeExclude').sort()).toEqual([
      '@plakboek/*',
      'create-plakboek',
    ]);
    expect(text).toMatch(/^trustPolicy: no-downgrade$/m);
    expect(text).toMatch(/^strictDepBuilds: true$/m);
    expect(text).toMatch(/^blockExoticSubdeps: true$/m);
    expect(text).toMatch(/^verifyStoreIntegrity: true$/m);
    expect(text).toMatch(/^strictStorePkgContentCheck: true$/m);
    expect(text).toMatch(/^dangerouslyAllowAllBuilds: false$/m);
    expect(text).toMatch(/^ {2}esbuild: false$/m);

    // Every trust exclusion the monorepo needed, the starter needs too.
    const shipped = yamlList(text, 'trustPolicyExclude');
    for (const entry of yamlList(root, 'trustPolicyExclude')) {
      expect(shipped).toContain(entry);
    }
    // The shipped policy never carries the proof-only overrides.
    expect(text).not.toMatch(/^overrides:/m);
  });

  it('ships an env example with no usable secret', async () => {
    const text = await read('.env.example');
    expect(text).not.toMatch(/^PLAKBOEK_SECRET=/m);
    expect(text).toContain('pnpm --silent secret >> .env');
    expect(text).toMatch(/^POSTGRES_USER=plakboek$/m);
    expect(text).toMatch(/^POSTGRES_PASSWORD=plakboek$/m);
    expect(text).toMatch(/^POSTGRES_DB=plakboek$/m);
    expect(text).toMatch(
      /^DATABASE_URL=postgres:\/\/plakboek:plakboek@127\.0\.0\.1:5432\/plakboek$/m,
    );
    expect(text).toMatch(/^# DATABASE_MIGRATION_URL=/m);
    expect(text).toMatch(/^PLAKBOEK_URL=http:\/\/localhost:5173$/m);
    expect(text).toMatch(/^PLAKBOEK_MAIL_FROM=/m);
    expect(text).toMatch(/^SITE_ADDRESS=localhost$/m);
  });

  it('wires the plugin before React Router and the server entry to core', async () => {
    const vite = await read('vite.config.ts');
    expect(vite).toContain("config: './plakboek.config.ts'");
    expect(vite).toContain("site: './app/site/index.ts'");
    expect(vite.indexOf('plakboek(')).toBeGreaterThan(-1);
    expect(vite.indexOf('plakboek({')).toBeLessThan(
      vite.indexOf('reactRouter()'),
    );
    expect(await read('server.ts')).toContain('await createServer().start()');
    expect(await read('react-router.config.ts')).toContain('ssr: true');
  });

  it('types the project strictly for bundler resolution', async () => {
    const tsconfig = JSON.parse(await read('tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
    };
    const options = tsconfig.compilerOptions;
    expect(options.strict).toBe(true);
    expect(options.noUncheckedIndexedAccess).toBe(true);
    expect(options.verbatimModuleSyntax).toBe(true);
    expect(options.moduleResolution).toBe('bundler');
    expect(options.module).toBe('preserve');
    expect(options.jsx).toBe('react-jsx');
    expect(options.allowImportingTsExtensions).toBe(true);
    expect(options.noEmit).toBe(true);
  });

  it('ships the CLI package with its template', async () => {
    const manifest = JSON.parse(
      await readFile(
        join(import.meta.dirname, '..', '..', 'package.json'),
        'utf8',
      ),
    ) as { files: string[] };
    expect(manifest.files).toEqual(['dist', 'template']);
  });
});
