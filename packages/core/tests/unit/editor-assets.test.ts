import { describe, expect, it } from 'vitest';
import {
  buildEditorSidecar,
  devEditorAssets,
  EDITOR_CHUNK_NAME,
  EDITOR_CLIENT_ID,
  editorAssetsFromSidecar,
  type BundleChunk,
  type BundleLike,
} from '../../src/editor-assets.js';

function chunk(
  fileName: string,
  overrides: Partial<BundleChunk> = {},
): BundleChunk {
  return {
    type: 'chunk',
    name: fileName,
    fileName,
    isEntry: false,
    imports: [],
    dynamicImports: [],
    moduleIds: [],
    ...overrides,
  };
}

describe('editorAssetsFromSidecar', () => {
  const sidecar = {
    file: 'assets/plakboek-editor-abc.js',
    imports: ['assets/react-def.js'],
    css: ['assets/plakboek-editor-ghi.css'],
  };

  it('prefixes every file with the base', () => {
    expect(editorAssetsFromSidecar(sidecar, '/')).toEqual({
      entry: '/assets/plakboek-editor-abc.js',
      preload: ['/assets/react-def.js'],
      css: ['/assets/plakboek-editor-ghi.css'],
    });
  });

  it('honours a custom base, with or without its trailing slash', () => {
    const withSlash = editorAssetsFromSidecar(sidecar, '/cms-static/');
    const without = editorAssetsFromSidecar(sidecar, '/cms-static');
    expect(withSlash).toEqual(without);
    expect(withSlash.entry).toBe('/cms-static/assets/plakboek-editor-abc.js');
  });

  it('sets no development scripts', () => {
    expect(editorAssetsFromSidecar(sidecar, '/').devScripts).toBeUndefined();
  });
});

describe('devEditorAssets', () => {
  it('points at the virtual module and Vite client under the base', () => {
    expect(devEditorAssets('/')).toEqual({
      entry: `/@id/__x00__${EDITOR_CLIENT_ID}`,
      preload: [],
      css: [],
      devScripts: [{ src: '/@vite/client' }],
    });
  });

  it('honours a custom base', () => {
    const assets = devEditorAssets('/site');
    expect(assets.entry).toBe(`/site/@id/__x00__${EDITOR_CLIENT_ID}`);
    expect(assets.devScripts).toEqual([{ src: '/site/@vite/client' }]);
  });
});

describe('buildEditorSidecar', () => {
  it('collects the entry, its transitive static imports and their css, but no dynamic import', () => {
    const bundle: BundleLike = {
      'assets/entry.client-1.js': chunk('assets/entry.client-1.js', {
        isEntry: true,
        name: 'entry.client',
      }),
      'assets/plakboek-editor-2.js': chunk('assets/plakboek-editor-2.js', {
        isEntry: true,
        name: EDITOR_CHUNK_NAME,
        imports: ['assets/react-3.js'],
        dynamicImports: ['assets/later-6.js'],
        viteMetadata: { importedCss: new Set(['assets/editor-4.css']) },
      }),
      'assets/react-3.js': chunk('assets/react-3.js', {
        imports: ['assets/scheduler-5.js'],
      }),
      'assets/scheduler-5.js': chunk('assets/scheduler-5.js', {
        viteMetadata: { importedCss: new Set(['assets/shared-7.css']) },
      }),
      'assets/later-6.js': chunk('assets/later-6.js'),
      'assets/logo.svg': { type: 'asset' },
    };
    expect(buildEditorSidecar(bundle)).toEqual({
      file: 'assets/plakboek-editor-2.js',
      imports: ['assets/react-3.js', 'assets/scheduler-5.js'],
      css: ['assets/editor-4.css', 'assets/shared-7.css'],
    });
  });

  it('is undefined for a bundle without the editor chunk', () => {
    expect(
      buildEditorSidecar({
        'assets/entry.client-1.js': chunk('assets/entry.client-1.js', {
          isEntry: true,
        }),
      }),
    ).toBeUndefined();
  });

  it('does not mistake a non-entry chunk of the same name for the editor', () => {
    expect(
      buildEditorSidecar({
        'assets/x.js': chunk('assets/x.js', { name: EDITOR_CHUNK_NAME }),
      }),
    ).toBeUndefined();
  });
});
