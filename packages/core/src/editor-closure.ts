/**
 * The build-time half of keeping editor code away from visitors: after the
 * client build, no chunk a visitor-facing entry can reach, statically or
 * through a dynamic import, may contain an editor module. The editor's own
 * chunk is the one exception, and the chunks only it reaches (such as a later
 * dynamic import of its own) are ignored because no visitor entry gets there.
 */
import {
  EDITOR_CLIENT_ID,
  findEditorChunk,
  type BundleChunk,
  type BundleLike,
} from './editor-assets.js';

/** One path from a non-editor entry to an editor module. */
export type EditorLeak = {
  /** The entry chunk the walk started from. */
  readonly entry: string;
  /** The reached chunk that contains the editor module. */
  readonly chunk: string;
  /** The editor module's id. */
  readonly module: string;
  /** The path fragment that made the module count as editor code. */
  readonly match: string;
};

const RESOLVED_EDITOR_CLIENT_ID = `\0${EDITOR_CLIENT_ID}`;
const BLOCK_EDIT_ID = 'virtual:plakboek/block-edit';
const RESOLVED_BLOCK_EDIT_ID = `\0${BLOCK_EDIT_ID}`;
/** What a module reports as the reason it counts, when the host's `blockEdit`
 * glob is what picked it. */
const BLOCK_EDIT_MODULE_MATCH = 'blockEdit glob';

/**
 * Path fragments of the editor package and of the libraries only it uses.
 * Each is whole path segments, so a host file that merely has the word in its
 * name (`app/blocks/prosemirror-notes.ts`) is not editor code. A library
 * counts only inside a `node_modules` directory, which also covers pnpm's
 * nested layout.
 */
const EDITOR_PATH_FRAGMENTS = [
  '/@plakboek/editor/',
  '/packages/editor/',
  '/node_modules/@tiptap/',
  '/node_modules/@dnd-kit/',
  '/node_modules/prosemirror-',
] as const;

/** A module id without its query and with forward slashes, so ids written by
 * different tools compare equal. */
function normaliseId(id: string): string {
  const path = id.replaceAll('\\', '/');
  return path.split('?')[0] ?? path;
}

/** The fragment that makes a module id editor code, or `undefined`. */
function editorMatch(
  id: string,
  blockEditModules: ReadonlySet<string>,
): string | undefined {
  if (id === RESOLVED_EDITOR_CLIENT_ID) return EDITOR_CLIENT_ID;
  if (id === RESOLVED_BLOCK_EDIT_ID) return BLOCK_EDIT_ID;
  const path = id.replaceAll('\\', '/');
  if (blockEditModules.has(normaliseId(id))) return BLOCK_EDIT_MODULE_MATCH;
  return EDITOR_PATH_FRAGMENTS.find((fragment) => path.includes(fragment));
}

function chunkOf(bundle: BundleLike, file: string): BundleChunk | undefined {
  const entry = bundle[file];
  return entry?.type === 'chunk' ? entry : undefined;
}

/** Every chunk reachable from `start`, itself included, in visiting order. */
function closure(bundle: BundleLike, start: string): readonly BundleChunk[] {
  const seen = new Set<string>();
  const reached: BundleChunk[] = [];
  const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const chunk = chunkOf(bundle, file);
    if (chunk === undefined) continue;
    reached.push(chunk);
    queue.push(...chunk.imports, ...chunk.dynamicImports);
  }
  return reached;
}

export type FindEditorLeaksOptions = {
  /**
   * The module ids the host's `blockEdit` glob matched: the block lifecycle
   * hook modules the editor loads. They count as editor code because the
   * build knows them by what the glob picked, not by how a file is named, so
   * an ordinary host module that happens to end in `.edit.tsx` (a route for
   * editing a profile) is not mistaken for one, and a hook module a custom
   * glob picked up under any name is not missed.
   */
  readonly blockEditModules?: Iterable<string>;
};

/**
 * Every editor module a non-editor entry can reach. The roots are the entry
 * chunks other than the editor's, plus any dynamic entry the editor chunk
 * does not reach. Each (entry, chunk) pair is reported once, with the first
 * editor module found in the chunk.
 */
export function findEditorLeaks(
  bundle: BundleLike,
  options: FindEditorLeaksOptions = {},
): readonly EditorLeak[] {
  const editor = findEditorChunk(bundle);
  if (editor === undefined) return [];
  const blockEditModules = new Set(
    [...(options.blockEditModules ?? [])].map(normaliseId),
  );

  const reachedByEditor = new Set(
    closure(bundle, editor.fileName).map((chunk) => chunk.fileName),
  );
  const roots = Object.values(bundle).filter(
    (item): item is BundleChunk =>
      item.type === 'chunk' &&
      item !== editor &&
      (item.isEntry ||
        (item.isDynamicEntry === true && !reachedByEditor.has(item.fileName))),
  );

  const leaks: EditorLeak[] = [];
  for (const root of roots) {
    for (const reached of closure(bundle, root.fileName)) {
      for (const module of reached.moduleIds) {
        const match = editorMatch(module, blockEditModules);
        if (match === undefined) continue;
        leaks.push(
          Object.freeze({
            entry: root.fileName,
            chunk: reached.fileName,
            module,
            match,
          }),
        );
        break;
      }
    }
  }
  return Object.freeze(leaks);
}
