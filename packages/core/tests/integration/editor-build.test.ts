/**
 * The editor's client is its own chunk in a real host build, found by the
 * server build through the sidecar the client build writes.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEADING_EDIT_MARKER } from '../fixture-host/blocks/heading.edit.ts';
import { FIXTURE_CLIENT_DIR, FIXTURE_SERVER_ENTRY } from './fixture-host.js';

type Sidecar = {
  file: string;
  imports: string[];
  css: string[];
};

function readSidecar(): Sidecar {
  return JSON.parse(
    readFileSync(join(FIXTURE_CLIENT_DIR, 'plakboek-editor.json'), 'utf8'),
  ) as Sidecar;
}

describe('the editor client chunk in a host build', () => {
  it('writes a sidecar next to the client assets', () => {
    expect(existsSync(join(FIXTURE_CLIENT_DIR, 'plakboek-editor.json'))).toBe(
      true,
    );
  });

  it('names an existing, hashed editor chunk under assets/', () => {
    const { file } = readSidecar();
    expect(file).toMatch(/^assets\/plakboek-editor-[\w-]+\.js$/);
    expect(existsSync(join(FIXTURE_CLIENT_DIR, file))).toBe(true);
  });

  it('lists only files the build emitted', () => {
    const { imports, css } = readSidecar();
    for (const file of [...imports, ...css]) {
      expect(existsSync(join(FIXTURE_CLIENT_DIR, file))).toBe(true);
    }
  });

  it('boots the editor from the chunk', () => {
    const { file } = readSidecar();
    const source = readFileSync(join(FIXTURE_CLIENT_DIR, file), 'utf8');
    expect(source).toContain('plakboek-editor');
  });

  it('is referenced by no other client asset', () => {
    const { file, imports } = readSidecar();
    const own = new Set([file, ...imports]);
    const assets = join(FIXTURE_CLIENT_DIR, 'assets');
    for (const name of readdirSync(assets)) {
      if (own.has(`assets/${name}`)) continue;
      expect(readFileSync(join(assets, name), 'utf8')).not.toContain(
        basename(file),
      );
    }
  });

  it('gives the server build the chunk URL', () => {
    const { file } = readSidecar();
    const serverAssets = join(FIXTURE_SERVER_ENTRY, '..');
    const sources = [
      FIXTURE_SERVER_ENTRY,
      ...listJs(join(serverAssets, 'assets')),
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(sources).toContain(`/${file}`);
  });

  it('holds a host block-edit module only in chunks the editor chunk reaches', () => {
    const assets = clientAssets();
    const editor = basename(readSidecar().file);
    const holders = [...assets]
      .filter(([, source]) => source.includes(HEADING_EDIT_MARKER))
      .map(([name]) => name);
    expect(holders.length).toBeGreaterThan(0);

    const editorSide = reachableFrom(editor, assets);
    for (const holder of holders) expect(editorSide.has(holder)).toBe(true);

    // Nothing outside the editor's own closure names a chunk that holds it.
    for (const [name, source] of assets) {
      if (editorSide.has(name)) continue;
      expect(referencedBy(source, holders)).toEqual([]);
    }
  });
});

/** Every JS asset of the client build, by file name. */
function clientAssets(): Map<string, string> {
  const assets = join(FIXTURE_CLIENT_DIR, 'assets');
  return new Map(
    listJs(assets).map((path) => [basename(path), readFileSync(path, 'utf8')]),
  );
}

/** The chunks a chunk names (static and dynamic imports both spell the file
 * name of their target in its source). */
function referencedBy(source: string, names: Iterable<string>): string[] {
  return [...names].filter((name) => source.includes(name));
}

/** `start` and every chunk reachable from it. */
function reachableFrom(
  start: string,
  assets: ReadonlyMap<string, string>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...referencedBy(assets.get(name) ?? '', assets.keys()));
  }
  return seen;
}

function listJs(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(directory, name));
}
