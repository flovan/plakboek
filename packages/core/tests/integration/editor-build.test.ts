/**
 * The editor's client is its own chunk in a real host build, found by the
 * server build through the sidecar the client build writes.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
        'plakboek-editor',
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
});

function listJs(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(directory, name));
}
