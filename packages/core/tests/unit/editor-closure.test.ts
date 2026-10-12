import { describe, expect, it } from 'vitest';
import {
  EDITOR_CHUNK_NAME,
  type BundleChunk,
  type BundleLike,
} from '../../src/editor-assets.js';
import { findEditorLeaks } from '../../src/editor-closure.js';

function chunk(
  fileName: string,
  overrides: Partial<BundleChunk> = {},
): BundleChunk {
  return {
    type: 'chunk',
    name: fileName.replace(/^assets\/|-\w+\.js$/g, ''),
    fileName,
    isEntry: false,
    imports: [],
    dynamicImports: [],
    moduleIds: [],
    ...overrides,
  };
}

const EDITOR_MODULE = '/work/node_modules/@plakboek/editor/dist/client.js';

/** A clean bundle: the client entry, a route chunk, a shared react chunk and
 * the editor chunk that shares react with the entry. */
function cleanBundle(): Record<string, BundleChunk> {
  return {
    'assets/entry.client-1.js': chunk('assets/entry.client-1.js', {
      isEntry: true,
      name: 'entry.client',
      imports: ['assets/react-3.js'],
      moduleIds: ['/work/app/entry.client.tsx'],
    }),
    'assets/home-2.js': chunk('assets/home-2.js', {
      isEntry: true,
      name: 'home',
      imports: ['assets/react-3.js'],
      moduleIds: ['/work/app/routes/home.tsx'],
    }),
    'assets/react-3.js': chunk('assets/react-3.js', {
      moduleIds: ['/work/node_modules/react/index.js'],
    }),
    'assets/plakboek-editor-4.js': chunk('assets/plakboek-editor-4.js', {
      isEntry: true,
      name: EDITOR_CHUNK_NAME,
      imports: ['assets/react-3.js'],
      dynamicImports: ['assets/auth-5.js'],
      moduleIds: ['\0virtual:plakboek/editor-client', EDITOR_MODULE],
    }),
    // Only the editor chunk reaches this one.
    'assets/auth-5.js': chunk('assets/auth-5.js', {
      isDynamicEntry: true,
      moduleIds: ['/work/node_modules/@plakboek/editor/dist/auth.js'],
    }),
  };
}

describe('findEditorLeaks', () => {
  it('finds nothing when the editor chunk and the client entry only share react', () => {
    expect(findEditorLeaks(cleanBundle())).toEqual([]);
  });

  it('finds nothing when only the editor chunk reaches editor modules, however deep', () => {
    const bundle: BundleLike = {
      ...cleanBundle(),
      'assets/auth-5.js': chunk('assets/auth-5.js', {
        isDynamicEntry: true,
        imports: ['assets/deep-6.js'],
        moduleIds: [EDITOR_MODULE],
      }),
      'assets/deep-6.js': chunk('assets/deep-6.js', {
        moduleIds: ['/work/node_modules/@tiptap/core/dist/index.js'],
      }),
    };
    expect(findEditorLeaks(bundle)).toEqual([]);
  });

  it('finds nothing, and does not throw, when there is no editor chunk', () => {
    const without = Object.fromEntries(
      Object.entries(cleanBundle()).filter(
        ([, item]) => item.name !== EDITOR_CHUNK_NAME,
      ),
    );
    expect(findEditorLeaks(without)).toEqual([]);
    expect(findEditorLeaks({})).toEqual([]);
  });

  it('ignores assets in the bundle', () => {
    expect(
      findEditorLeaks({ ...cleanBundle(), 'assets/x.svg': { type: 'asset' } }),
    ).toEqual([]);
  });

  it('names the route chunk, the reached chunk and the module of a static leak', () => {
    const bundle: BundleLike = {
      ...cleanBundle(),
      'assets/home-2.js': chunk('assets/home-2.js', {
        isEntry: true,
        name: 'home',
        imports: ['assets/react-3.js', 'assets/leaky-7.js'],
        moduleIds: ['/work/app/routes/home.tsx'],
      }),
      'assets/leaky-7.js': chunk('assets/leaky-7.js', {
        moduleIds: ['/work/app/util.ts', EDITOR_MODULE],
      }),
    };
    expect(findEditorLeaks(bundle)).toEqual([
      {
        entry: 'assets/home-2.js',
        chunk: 'assets/leaky-7.js',
        module: EDITOR_MODULE,
        match: '/@plakboek/editor/',
      },
    ]);
  });

  it('follows a dynamic import edge', () => {
    const bundle: BundleLike = {
      ...cleanBundle(),
      'assets/entry.client-1.js': chunk('assets/entry.client-1.js', {
        isEntry: true,
        name: 'entry.client',
        imports: ['assets/react-3.js'],
        dynamicImports: ['assets/lazy-8.js'],
      }),
      'assets/lazy-8.js': chunk('assets/lazy-8.js', {
        moduleIds: ['/work/node_modules/@plakboek/editor/dist/server.js'],
      }),
    };
    expect(findEditorLeaks(bundle)).toEqual([
      {
        entry: 'assets/entry.client-1.js',
        chunk: 'assets/lazy-8.js',
        module: '/work/node_modules/@plakboek/editor/dist/server.js',
        match: '/@plakboek/editor/',
      },
    ]);
  });

  it('follows a chain of imports and reports the leak once per entry', () => {
    const bundle: BundleLike = {
      ...cleanBundle(),
      'assets/home-2.js': chunk('assets/home-2.js', {
        isEntry: true,
        name: 'home',
        imports: ['assets/a-7.js'],
      }),
      'assets/a-7.js': chunk('assets/a-7.js', { imports: ['assets/b-8.js'] }),
      'assets/b-8.js': chunk('assets/b-8.js', {
        imports: ['assets/a-7.js'],
        moduleIds: [EDITOR_MODULE],
      }),
    };
    expect(findEditorLeaks(bundle)).toEqual([
      {
        entry: 'assets/home-2.js',
        chunk: 'assets/b-8.js',
        module: EDITOR_MODULE,
        match: '/@plakboek/editor/',
      },
    ]);
  });

  it('treats a dynamic entry nothing in the editor reaches as a root too', () => {
    const bundle: BundleLike = {
      ...cleanBundle(),
      'assets/lazy-9.js': chunk('assets/lazy-9.js', {
        isDynamicEntry: true,
        moduleIds: ['/work/app/lazy.tsx', '/work/packages/editor/src/x.ts'],
      }),
    };
    expect(findEditorLeaks(bundle)).toEqual([
      {
        entry: 'assets/lazy-9.js',
        chunk: 'assets/lazy-9.js',
        module: '/work/packages/editor/src/x.ts',
        match: '/packages/editor/',
      },
    ]);
  });

  it.each([
    ['a workspace editor source path', '/work/packages/editor/src/client.ts'],
    ['the editor client virtual id', '\0virtual:plakboek/editor-client'],
    ['a TipTap module', '/work/node_modules/@tiptap/react/dist/index.js'],
    ['a dnd-kit module', '/work/node_modules/@dnd-kit/core/dist/core.js'],
    ['a ProseMirror module', '/work/node_modules/prosemirror-model/dist/i.js'],
    [
      'a Windows-style editor path',
      'C:\\work\\node_modules\\@plakboek\\editor\\dist\\client.js',
    ],
  ])('matches %s', (_label, moduleId) => {
    const bundle: BundleLike = {
      ...cleanBundle(),
      'assets/home-2.js': chunk('assets/home-2.js', {
        isEntry: true,
        name: 'home',
        moduleIds: [moduleId],
      }),
    };
    expect(findEditorLeaks(bundle)).toHaveLength(1);
  });

  it('does not match look-alike module paths', () => {
    const bundle: BundleLike = {
      ...cleanBundle(),
      'assets/home-2.js': chunk('assets/home-2.js', {
        isEntry: true,
        name: 'home',
        moduleIds: [
          '/work/app/editor/toolbar.tsx',
          '/work/node_modules/@plakboek/editorial/dist/i.js',
          '/work/node_modules/@plakboek/render/dist/i.js',
          // A host file that only has the word in its name.
          '/work/app/blocks/prosemirror-notes.ts',
          '/work/app/lib/tiptap-lite.ts',
          '/work/app/dnd-kit-helpers.ts',
          // A host's own folder named after a library.
          '/work/app/@tiptap/local.ts',
        ],
      }),
    };
    expect(findEditorLeaks(bundle)).toEqual([]);
  });

  it('names the fragment that made a module count, so a host can see why', () => {
    const [leak] = findEditorLeaks({
      ...cleanBundle(),
      'assets/home-2.js': chunk('assets/home-2.js', {
        isEntry: true,
        name: 'home',
        moduleIds: [
          '/work/node_modules/.pnpm/prosemirror-model@1/node_modules/prosemirror-model/dist/i.js',
        ],
      }),
    });
    expect(leak?.match).toBe('/node_modules/prosemirror-');
  });

  it('returns frozen records', () => {
    const [leak] = findEditorLeaks({
      ...cleanBundle(),
      'assets/home-2.js': chunk('assets/home-2.js', {
        isEntry: true,
        name: 'home',
        moduleIds: [EDITOR_MODULE],
      }),
    });
    expect(Object.isFrozen(leak)).toBe(true);
  });
});
