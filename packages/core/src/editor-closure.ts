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
};

const RESOLVED_EDITOR_CLIENT_ID = `\0${EDITOR_CLIENT_ID}`;

/** Path fragments of the editor package and of the libraries only it uses. */
const EDITOR_PATH_FRAGMENTS = [
  '/@plakboek/editor/',
  '/packages/editor/',
  '@tiptap/',
  '@dnd-kit/',
  'prosemirror',
  '@plakboek/admin',
] as const;

function isEditorModule(id: string): boolean {
  if (id === RESOLVED_EDITOR_CLIENT_ID) return true;
  const path = id.replaceAll('\\', '/');
  return EDITOR_PATH_FRAGMENTS.some((fragment) => path.includes(fragment));
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

/**
 * Every editor module a non-editor entry can reach. The roots are the entry
 * chunks other than the editor's, plus any dynamic entry the editor chunk
 * does not reach. Each (entry, chunk) pair is reported once, with the first
 * editor module found in the chunk.
 */
export function findEditorLeaks(bundle: BundleLike): readonly EditorLeak[] {
  const editor = findEditorChunk(bundle);
  if (editor === undefined) return [];

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
      const module = reached.moduleIds.find(isEditorModule);
      if (module !== undefined) {
        leaks.push(
          Object.freeze({
            entry: root.fileName,
            chunk: reached.fileName,
            module,
          }),
        );
      }
    }
  }
  return Object.freeze(leaks);
}
