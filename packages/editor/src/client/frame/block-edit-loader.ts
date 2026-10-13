import type { BlockEditHooks } from '@plakboek/render';

/**
 * The host's block edit modules as the `plakboek()` Vite plugin hands them to
 * the editor: one lazy import per `*.edit.ts` file, keyed by its project path.
 */
export type BlockEditLoaders = Readonly<Record<string, () => Promise<unknown>>>;

const HOOK_NAMES = [
  'enter',
  'leave',
  'select',
  'deselect',
  'reveal',
  'rendered',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The module's `{ blockType, hooks }` when its default export has that shape. */
function readModule(
  loaded: unknown,
): { blockType: string; hooks: BlockEditHooks } | undefined {
  if (!isRecord(loaded)) return undefined;
  const value = loaded['default'];
  if (!isRecord(value)) return undefined;
  const { blockType, hooks } = value;
  if (typeof blockType !== 'string' || blockType === '') return undefined;
  if (!isRecord(hooks)) return undefined;
  for (const name of HOOK_NAMES) {
    const hook = hooks[name];
    if (hook !== undefined && typeof hook !== 'function') return undefined;
  }
  // The checks above prove every present member is a function, which is all
  // `BlockEditHooks` asks of an object.
  return { blockType, hooks: hooks as BlockEditHooks };
}

/**
 * Reports go to the console as one line naming the file key and nothing from
 * the module's own error, which may carry host data.
 */
function defaultReport(message: string): void {
  // oxlint-disable-next-line no-console -- the documented default report; the editor has no logger and the message is already redacted
  console.warn(`[plakboek] ${message}`);
}

/**
 * Loads every block edit module once and keeps the valid ones. A loader that
 * rejects, a default export that is not `{ blockType, hooks }` with function
 * members, or a second module for a block type already taken is reported by
 * file key (and block type) and skipped, so one broken module never stops the
 * editor or the other blocks' hooks. The first valid module per block type
 * wins.
 */
export async function loadBlockEditModules(
  loaders: BlockEditLoaders,
  report: (message: string) => void = defaultReport,
): Promise<ReadonlyMap<string, BlockEditHooks>> {
  const entries = Object.entries(loaders);
  const settled = await Promise.allSettled(
    entries.map(([, load]) => Promise.resolve().then(load)),
  );
  const hooksByType = new Map<string, BlockEditHooks>();
  entries.forEach(([key], index) => {
    const result = settled[index];
    if (result?.status !== 'fulfilled') {
      report(`Block edit module ${key} failed to load and was skipped.`);
      return;
    }
    const found = readModule(result.value);
    if (found === undefined) {
      report(
        `Block edit module ${key} does not default-export a valid { blockType, hooks } and was skipped.`,
      );
      return;
    }
    if (hooksByType.has(found.blockType)) {
      report(
        `Block edit module ${key} repeats the hooks of block type "${found.blockType}" and was skipped.`,
      );
      return;
    }
    hooksByType.set(found.blockType, found.hooks);
  });
  return hooksByType;
}
