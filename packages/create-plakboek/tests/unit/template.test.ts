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
    expect(shared.length).toBeGreaterThanOrEqual(14);
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

describe('starter template host code', () => {
  it('contains every host code file', async () => {
    const files = await listFiles(TEMPLATE);
    for (const file of [
      'plakboek.config.ts',
      'seed.ts',
      'blocks/section.tsx',
      'blocks/heading.tsx',
      'app/routes.ts',
      'app/root.tsx',
      'app/site/index.ts',
      'app/app.css',
      'app/site/document.tsx',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('holds each config placeholder exactly once', async () => {
    const text = await read('plakboek.config.ts');
    for (const token of [
      "'__SITE_NAME__'",
      "'__DEFAULT_LOCALE__'",
      "['__LOCALES__']",
      "'__TIMEZONE__'",
    ]) {
      expect(text.split(token)).toHaveLength(2);
    }
  });

  it('keeps the config loadable by Node: no Vite-only syntax, no site imports', async () => {
    const text = await read('plakboek.config.ts');
    for (const forbidden of ['?url', 'import.meta.env', 'import.meta.glob']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/from '\.\/app\//);
    const imports = [...text.matchAll(/from '([^']+)'/g)].map(
      (m) => m[1] ?? '',
    );
    expect(imports.sort()).toEqual([
      './blocks/heading.tsx',
      './blocks/section.tsx',
      './seed.ts',
      '@plakboek/core/config',
    ]);
  });

  it('registers both blocks explicitly and composes the default roles and menu', async () => {
    const text = await read('plakboek.config.ts');
    expect(text).toContain('blocks: [section, heading]');
    expect(text).toContain('roles: { ...defaultRoles }');
    expect(text).toContain("menus: { main: [{ label: 'Home', href: '/' }] }");
    expect(text).toContain('constraints: []');
    expect(text).toContain('modules: []');
    expect(text).toMatch(/^ {2}seed,$/m);
  });

  it('seeds one section holding one level 1 heading, as host code', async () => {
    const text = await read('seed.ts');
    expect(text).toContain("import type { SeedPage } from '@plakboek/core'");
    expect(text).toMatch(/export const seed: SeedPage/);
    expect(text).toContain("title: 'Home'");
    expect(text).toContain("type: 'section'");
    expect(text).toContain("width: 'contained'");
    expect(text).toContain("spacing: 'lg'");
    expect(text).toContain("type: 'heading'");
    expect(text).toContain("text: 'Hello world'");
    expect(text).toContain("level: '1'");
    expect(text.match(/type: '/g)).toHaveLength(2);
  });

  it('writes one defineBlock definition per block file', async () => {
    for (const file of ['blocks/section.tsx', 'blocks/heading.tsx']) {
      const text = await read(file);
      expect(text.match(/defineBlock\(/g)).toHaveLength(1);
      expect(text.match(/^export const /gm)).toHaveLength(1);
      // Plain function components only: the visitor handler rejects wrappers.
      expect(text).not.toMatch(/\b(memo|forwardRef)\(/);
      expect(text).toContain('{...edit');
    }
  });

  it('declares section as a layout-only block', async () => {
    const text = await read('blocks/section.tsx');
    expect(text).toContain("key: 'section'");
    expect(text).toContain("kind: 'section'");
    const keys = [...text.matchAll(/^ {4}(\w+): \{$/gm)].map((m) => m[1] ?? '');
    expect(keys.sort()).toEqual(['spacing', 'width']);
    for (const value of ['contained', 'full', 'none', 'md', 'lg']) {
      expect(text).toContain(`value: '${value}'`);
    }
    expect(text).toContain("defaultValue: 'lg'");
    expect(text).toContain('py-0');
    expect(text).toContain('py-8');
    expect(text).toContain('py-16');
    expect(text).toContain('max-w-[1120px]');
  });

  it('declares heading with a required text and a level of 1 to 3', async () => {
    const text = await read('blocks/heading.tsx');
    expect(text).toContain("key: 'heading'");
    expect(text).not.toContain("kind: 'section'");
    expect(text).toMatch(/text: \{[^}]*fieldType: 'short_text'/s);
    expect(text).toContain('required: true');
    for (const value of ['1', '2', '3']) {
      expect(text).toContain(`value: '${value}'`);
    }
    expect(text).toContain("defaultValue: '2'");
    expect(text).toContain('text-3xl font-semibold');
    expect(text).toContain('text-xl font-semibold');
    expect(text).toContain('text-sm font-semibold');
    expect(text).toContain("{...edit.field('text')}");
  });

  it('lists host routes before the CMS routes', async () => {
    const text = await read('app/routes.ts');
    expect(text.match(/cmsRoutes\(\)/g)).toHaveLength(1);
    expect(text).toContain('[...hostRoutes, ...cmsRoutes()]');
    expect(text).toMatch(/const hostRoutes: RouteConfigEntry\[\] = \[\];/);
  });

  it('composes the root route with the React Router document parts', async () => {
    const text = await read('app/root.tsx');
    for (const part of [
      'Meta',
      'Links',
      'Scripts',
      'ScrollRestoration',
      'Outlet',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).toContain('export function Layout');
    expect(text).toContain('export default function Root');
  });

  it('carries no attribution and no reference-project wording anywhere', async () => {
    for (const file of await listFiles(TEMPLATE)) {
      expect(await read(file)).not.toMatch(
        /co-authored|generated with|emdash/i,
      );
    }
  });
});

describe('starter theme and root template', () => {
  /** The declarations of the single `@theme { ... }` block. */
  async function themeBlock(): Promise<string> {
    const css = await read('app/app.css');
    const match = /@theme\s*\{([^}]*)\}/.exec(css);
    expect(match?.[1]).toBeDefined();
    return match?.[1] ?? '';
  }

  it('starts the stylesheet with the Tailwind import', async () => {
    const css = await read('app/app.css');
    expect(css.trimStart().startsWith("@import 'tailwindcss';")).toBe(true);
    expect(css.match(/@theme/g)).toHaveLength(1);
  });

  it('resets the colour and text namespaces so no other value exists', async () => {
    const theme = await themeBlock();
    expect(theme).toMatch(/--color-\*:\s*initial;/);
    expect(theme).toMatch(/--text-\*:\s*initial;/);
  });

  it('defines the six colour tokens with the contract values', async () => {
    const theme = await themeBlock();
    const expected: Record<string, string> = {
      '--color-surface': '#ffffff',
      '--color-surface-muted': '#f4f4f5',
      '--color-text': '#27272a',
      '--color-text-muted': '#52525b',
      '--color-accent': '#1d4ed8',
      '--color-border': '#e4e4e7',
    };
    for (const [token, value] of Object.entries(expected)) {
      expect(theme).toMatch(new RegExp(`${token}:\\s*${value};`));
    }
    const colours = [...theme.matchAll(/^\s*(--color-[a-z-]+):/gm)]
      .map((m) => m[1] ?? '')
      .filter((name) => name !== '--color-*');
    expect(colours.sort()).toEqual(Object.keys(expected).sort());
  });

  it('defines the four text sizes with their line heights, the 4px spacing unit and the system font', async () => {
    const theme = await themeBlock();
    const sizes: Record<string, [string, string]> = {
      sm: ['14px', '1.5'],
      base: ['16px', '1.5'],
      xl: ['20px', '1.2'],
      '3xl': ['28px', '1.2'],
    };
    for (const [name, [size, lineHeight]] of Object.entries(sizes)) {
      expect(theme).toMatch(new RegExp(`--text-${name}:\\s*${size};`));
      expect(theme).toMatch(
        new RegExp(`--text-${name}--line-height:\\s*${lineHeight};`),
      );
    }
    const sizeNames = [...theme.matchAll(/^\s*--text-([a-z0-9]+):/gm)].map(
      (m) => m[1] ?? '',
    );
    expect(sizeNames.sort()).toEqual(['3xl', 'base', 'sm', 'xl']);
    expect(theme).toMatch(/--spacing:\s*4px;/);
    expect(theme).toMatch(/--font-sans:\s*[^;]*system-ui[^;]*;/);
  });

  it('keeps the site light-only', async () => {
    expect(await read('app/app.css')).toMatch(/color-scheme:\s*light;/);
  });

  it('adds the Tailwind plugin before the CMS and React Router plugins', async () => {
    const vite = await read('vite.config.ts');
    expect(vite).toContain("from '@tailwindcss/vite'");
    expect(vite.indexOf('tailwindcss()')).toBeGreaterThan(-1);
    expect(vite.indexOf('tailwindcss()')).toBeLessThan(
      vite.indexOf('plakboek({'),
    );
    expect(vite.indexOf('plakboek({')).toBeLessThan(
      vite.indexOf('reactRouter()'),
    );
  });

  it('declares Tailwind 4.3 as a development dependency', async () => {
    const manifest = await templateManifest();
    expect(manifest.devDependencies?.tailwindcss).toBe('^4.3.0');
    expect(manifest.devDependencies?.['@tailwindcss/vite']).toBe('^4.3.0');
  });

  it('composes a script-free document around the page head, chrome and body', async () => {
    const text = await read('app/site/document.tsx');
    expect(text).toContain('export async function renderDocument(');
    expect(text).toContain('export async function renderPage(');
    expect(text).toContain('<!DOCTYPE html>');
    expect(text).toContain('<html lang=');
    expect(text).toContain('<meta charset="utf-8">');
    expect(text).toContain('name="viewport"');
    expect(text).toContain('name="color-scheme" content="light"');
    expect(text).toContain('renderHeadHtml(');
    expect(text).toContain('renderToStaticMarkup(');
    expect(text).toContain('<main id="content"');
    expect(text).not.toContain('<script');
  });

  it('puts the skip link first, then header, main and footer', async () => {
    const text = await read('app/site/document.tsx');
    expect(text).toContain('href="#content"');
    const order = [
      'Skip to content',
      '${header}',
      '<main id="content"',
      '${footer}',
    ].map((needle) => text.indexOf(needle));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('links one stylesheet, with ?direct only inside the development branch', async () => {
    const text = await read('app/site/document.tsx');
    expect(text).toContain("import appCss from '../app.css?url'");
    const withDirect = text
      .split('\n')
      .filter((line) => line.includes('?direct'));
    expect(withDirect).toHaveLength(1);
    expect(withDirect[0]).toContain('import.meta.env.DEV');
    expect(text.match(/rel="stylesheet"/g)).toHaveLength(1);
  });

  it('links the same stylesheet for host routes', async () => {
    const text = await read('app/root.tsx');
    expect(text).toContain("import appCss from './app.css?url'");
    expect(text).toContain("rel: 'stylesheet'");
    expect(text).toContain('export const links');
    expect(text).toContain('import.meta.env.DEV');
  });

  it('keeps the site module and the stylesheet out of the Node-loaded config', async () => {
    const config = await read('plakboek.config.ts');
    expect(config).not.toContain('app.css');
    expect(config).not.toContain('document.tsx');
  });

  it('exports the document hook from the site barrel', async () => {
    const text = await read('app/site/index.ts');
    expect(text).toContain("export { renderDocument } from './document.tsx'");
  });

  it('makes the body a full-height flex column on the surface colour', async () => {
    const text = await read('app/site/document.tsx');
    expect(text).toContain(
      'flex min-h-screen flex-col bg-surface font-sans text-text',
    );
  });
});
