import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PlakboekEnvError,
  SECRET_GENERATION_COMMAND,
} from '../../src/runtime/env.js';
import { plakboek, type PlakboekPluginOptions } from '../../src/vite.js';

const VIRTUAL_ID = 'virtual:plakboek/host';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const EDITOR_CLIENT_ID = 'virtual:plakboek/editor-client';
const RESOLVED_EDITOR_CLIENT_ID = `\0${EDITOR_CLIENT_ID}`;
const ROOT = '/work/host';

type Hook = (this: unknown, ...args: unknown[]) => unknown;

function callHook(
  hook: unknown,
  context: unknown,
  ...args: unknown[]
): unknown {
  const fn = (
    typeof hook === 'function' ? hook : (hook as { handler: Hook }).handler
  ) as Hook;
  return fn.call(context, ...args);
}

function instance(options: Partial<PlakboekPluginOptions> = {}): Plugin {
  const plugin = plakboek({
    config: './plakboek.config.ts',
    site: './app/site.ts',
    ...options,
  });
  callHook(plugin.configResolved, undefined, { root: ROOT, base: '/' });
  return plugin;
}

function load(plugin: Plugin, environment: 'ssr' | 'client'): string {
  return callHook(
    plugin.load,
    { environment: { name: environment } },
    RESOLVED_ID,
  ) as string;
}

describe('plakboek() virtual host module', () => {
  it('resolves its virtual id and nothing else', () => {
    const plugin = instance();
    expect(callHook(plugin.resolveId, undefined, VIRTUAL_ID)).toBe(RESOLVED_ID);
    expect(callHook(plugin.resolveId, undefined, 'other')).toBeUndefined();
  });

  it('exports edit as undefined for the ssr environment without the option', () => {
    const source = load(instance(), 'ssr');
    expect(source).toContain('export const edit = undefined;');
    expect(source).toContain(JSON.stringify(resolve(ROOT, './app/site.ts')));
  });

  it('re-exports the host edit module from its absolute path with the option', () => {
    const source = load(instance({ edit: './app/edit.ts' }), 'ssr');
    expect(source).toContain(
      `export { edit } from ${JSON.stringify(resolve(ROOT, './app/edit.ts'))};`,
    );
    expect(source).not.toContain('export const edit = undefined;');
  });

  it('keeps the client stub inert and free of host paths', () => {
    const source = load(instance({ edit: './app/edit.ts' }), 'client');
    expect(source).toContain('export const edit = undefined;');
    expect(source).not.toContain('edit.ts');
    expect(source).not.toContain('site.ts');
    expect(source).not.toContain('plakboek.config');
    expect(source).not.toContain(ROOT);
  });

  it('exports the development editor assets for the ssr environment when serving', () => {
    const source = load(instance(), 'ssr');
    expect(source).toContain('export const editorAssets = {');
    expect(source).toContain('/@vite/client');
    expect(source).toContain(`/@id/__x00__${EDITOR_CLIENT_ID}`);
  });

  it('exports editorAssets as undefined for the client environment', () => {
    expect(load(instance(), 'client')).toContain(
      'export const editorAssets = undefined;',
    );
  });

  it('answers load for no other module', () => {
    expect(
      callHook(instance().load, { environment: { name: 'ssr' } }, 'x'),
    ).toBeUndefined();
  });
});

describe('plakboek() editor chunk', () => {
  function building(base = '/'): Plugin {
    const plugin = plakboek({ config: './c.ts', site: './s.ts' });
    callHook(
      plugin.config,
      undefined,
      { root: ROOT },
      { mode: 'production', command: 'build' },
    );
    callHook(plugin.configResolved, undefined, { root: ROOT, base });
    return plugin;
  }

  const clientEnvironment = { environment: { name: 'client' } };

  function bundleWithEditor(): Record<string, unknown> {
    return {
      'assets/plakboek-editor-abc.js': {
        type: 'chunk',
        name: 'plakboek-editor',
        fileName: 'assets/plakboek-editor-abc.js',
        isEntry: true,
        imports: ['assets/react-def.js'],
        dynamicImports: [],
        moduleIds: [],
        viteMetadata: { importedCss: new Set(['assets/editor-ghi.css']) },
      },
      'assets/react-def.js': {
        type: 'chunk',
        name: 'react',
        fileName: 'assets/react-def.js',
        isEntry: false,
        imports: [],
        dynamicImports: [],
        moduleIds: [],
      },
    };
  }

  it('resolves the editor client id, and its resolved form, to one module', () => {
    const plugin = instance();
    expect(callHook(plugin.resolveId, undefined, EDITOR_CLIENT_ID)).toBe(
      RESOLVED_EDITOR_CLIENT_ID,
    );
    expect(
      callHook(plugin.resolveId, undefined, RESOLVED_EDITOR_CLIENT_ID),
    ).toBe(RESOLVED_EDITOR_CLIENT_ID);
  });

  it('loads a module that imports bootEditor from the editor client entry and calls it', () => {
    const source = callHook(
      instance().load,
      { environment: { name: 'client' } },
      RESOLVED_EDITOR_CLIENT_ID,
    ) as string;
    const lines = source.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^import \{ bootEditor \} from ".*editor.*client\.js";$/,
    );
    expect(lines[1]).toBe('bootEditor();');
  });

  it('emits the editor chunk when building the client, and only then', () => {
    const emitFile = vi.fn();
    const plugin = building();
    callHook(plugin.buildStart, { environment: { name: 'client' }, emitFile });
    expect(emitFile).toHaveBeenCalledWith({
      type: 'chunk',
      id: EDITOR_CLIENT_ID,
      name: 'plakboek-editor',
    });

    emitFile.mockClear();
    callHook(plugin.buildStart, { environment: { name: 'ssr' }, emitFile });
    callHook(instance().buildStart, {
      environment: { name: 'client' },
      emitFile,
    });
    expect(emitFile).not.toHaveBeenCalled();
  });

  it('writes the sidecar for the client bundle and hands its URLs to the server build', () => {
    const emitFile = vi.fn();
    const plugin = building('/static/');
    callHook(
      plugin.generateBundle,
      { ...clientEnvironment, emitFile },
      {},
      bundleWithEditor(),
    );
    expect(emitFile).toHaveBeenCalledTimes(1);
    const emitted = emitFile.mock.calls[0]?.[0] as {
      type: string;
      fileName: string;
      source: string;
    };
    expect(emitted.type).toBe('asset');
    expect(emitted.fileName).toBe('plakboek-editor.json');
    expect(JSON.parse(emitted.source)).toEqual({
      file: 'assets/plakboek-editor-abc.js',
      imports: ['assets/react-def.js'],
      css: ['assets/editor-ghi.css'],
    });

    const server = callHook(
      plugin.load,
      { environment: { name: 'ssr' } },
      RESOLVED_ID,
    ) as string;
    expect(server).toContain(
      `export const editorAssets = ${JSON.stringify({
        entry: '/static/assets/plakboek-editor-abc.js',
        preload: ['/static/assets/react-def.js'],
        css: ['/static/assets/editor-ghi.css'],
      })};`,
    );
  });

  it('writes no sidecar for a server bundle', () => {
    const emitFile = vi.fn();
    callHook(
      building().generateBundle,
      { environment: { name: 'ssr' }, emitFile },
      {},
      bundleWithEditor(),
    );
    expect(emitFile).not.toHaveBeenCalled();
  });

  it('fails the server build with a clear message when no client build ran first', () => {
    expect(() =>
      callHook(building().load, { environment: { name: 'ssr' } }, RESOLVED_ID),
    ).toThrow(/client build/);
  });
});

const VALID_ENV = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  PLAKBOEK_URL: 'http://localhost:5173',
  PLAKBOEK_SECRET: 'unit-test-secret-0123456789-abcdefghijklmnop',
};

describe('plakboek() development hooks', () => {
  const touched: string[] = [];
  const temporaryRoots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of touched.splice(0))
      Reflect.deleteProperty(process.env, key);
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function rootWithEnvFile(contents: string): string {
    const root = mkdtempSync(join(tmpdir(), 'plakboek-vite-'));
    temporaryRoots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.env'), contents);
    return root;
  }

  it('loads .env into process.env on serve without overriding preset variables', () => {
    const root = rootWithEnvFile('PLAKBOEK_URL=http://x.test\nFOO=from-file\n');
    touched.push('PLAKBOEK_URL', 'FOO');
    Reflect.deleteProperty(process.env, 'PLAKBOEK_URL');
    process.env.FOO = 'from-env';

    callHook(
      plakboek({ config: './c.ts', site: './s.ts' }).config,
      undefined,
      { root },
      { mode: 'development', command: 'serve' },
    );

    expect(process.env.PLAKBOEK_URL).toBe('http://x.test');
    expect(process.env.FOO).toBe('from-env');
  });

  it('does not load .env for a build', () => {
    const root = rootWithEnvFile('PLAKBOEK_BUILD_ONLY_PROBE=leaked\n');
    touched.push('PLAKBOEK_BUILD_ONLY_PROBE');
    Reflect.deleteProperty(process.env, 'PLAKBOEK_BUILD_ONLY_PROBE');

    callHook(
      plakboek({ config: './c.ts', site: './s.ts' }).config,
      undefined,
      { root },
      { mode: 'production', command: 'build' },
    );

    expect(process.env.PLAKBOEK_BUILD_ONLY_PROBE).toBeUndefined();
  });

  it('keeps the existing ssr noExternal setting', () => {
    const result = callHook(
      plakboek({ config: './c.ts', site: './s.ts' }).config,
      undefined,
      { root: ROOT },
      { mode: 'production', command: 'build' },
    ) as { ssr: { noExternal: string[] } };
    expect(result.ssr.noExternal).toEqual(['@plakboek/core']);
  });

  function configured(command: 'serve' | 'build'): Plugin {
    const plugin = plakboek({ config: './c.ts', site: './s.ts' });
    callHook(
      plugin.config,
      undefined,
      { root: mkdtempSync(join(tmpdir(), 'plakboek-vite-')) },
      { mode: command === 'serve' ? 'development' : 'production', command },
    );
    return plugin;
  }

  it('refuses to start the dev server when the secret is missing, naming the generation command', () => {
    for (const key of Object.keys(VALID_ENV))
      vi.stubEnv(key, VALID_ENV[key as keyof typeof VALID_ENV]);
    vi.stubEnv('PLAKBOEK_SECRET', '');
    const plugin = configured('serve');

    let thrown: unknown;
    try {
      callHook(plugin.configureServer, undefined, {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PlakboekEnvError);
    expect((thrown as Error).message).toContain(SECRET_GENERATION_COMMAND);
  });

  it('starts the dev server with a valid environment', () => {
    for (const key of Object.keys(VALID_ENV))
      vi.stubEnv(key, VALID_ENV[key as keyof typeof VALID_ENV]);
    const plugin = configured('serve');
    expect(() => callHook(plugin.configureServer, undefined, {})).not.toThrow();
  });

  it('never validates the environment for a build', () => {
    for (const key of Object.keys(VALID_ENV)) vi.stubEnv(key, '');
    const plugin = configured('build');
    expect(() => callHook(plugin.configureServer, undefined, {})).not.toThrow();
  });

  function hotUpdate(
    plugin: Plugin,
    environment: 'ssr' | 'client',
    modules: unknown[],
  ): number {
    const send = vi.fn();
    callHook(
      plugin.hotUpdate,
      { environment: { name: environment } },
      {
        modules,
        server: { ws: { send } },
      },
    );
    for (const call of send.mock.calls) {
      expect(call[0]).toEqual({ type: 'full-reload' });
    }
    return send.mock.calls.length;
  }

  it('sends exactly one full-reload for an ssr update', () => {
    const plugin = instance();
    expect(hotUpdate(plugin, 'ssr', [{ id: 'a' }, { id: 'b' }])).toBe(1);
  });

  it('sends nothing for a client update or an ssr update without modules', () => {
    const plugin = instance();
    expect(hotUpdate(plugin, 'client', [{ id: 'a' }])).toBe(0);
    expect(hotUpdate(plugin, 'ssr', [])).toBe(0);
  });
});
