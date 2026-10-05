import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { plakboek, type PlakboekPluginOptions } from '../../src/vite.js';

const VIRTUAL_ID = 'virtual:plakboek/host';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
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
  callHook(plugin.configResolved, undefined, { root: ROOT });
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

  it('answers load for no other module', () => {
    expect(
      callHook(instance().load, { environment: { name: 'ssr' } }, 'x'),
    ).toBeUndefined();
  });
});
