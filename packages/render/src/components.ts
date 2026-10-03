/**
 * The block-type to component map (D-09). `@plakboek/pages` keeps
 * `BlockDefinition.component` opaque; this module narrows it, once, when a
 * handler is created. The request path reads this map and never the
 * process-wide block registry, so two handlers over two configs in one
 * process stay independent (D-04).
 */
import type { BlockDefinition } from '@plakboek/pages';
import type { BlockComponent } from './block-component.js';
import { reportRenderEvent, type RenderHooks } from './hooks.js';

export type ComponentMap = ReadonlyMap<string, BlockComponent>;

/**
 * True only for a plain function the renderer can call directly. A `memo` or
 * `forwardRef` value is an object, and a class (React or native) throws when
 * called without `new`, so a class is refused up front instead of failing
 * every request.
 */
function isPlainFunctionComponent(value: unknown): value is BlockComponent {
  if (typeof value !== 'function') return false;
  const prototype: unknown = value.prototype;
  if (
    typeof prototype === 'object' &&
    prototype !== null &&
    Reflect.get(prototype, 'isReactComponent') !== undefined
  ) {
    return false;
  }
  return !/^class[\s{]/.test(Function.prototype.toString.call(value));
}

/**
 * The keys of the blocks whose `component` is defined but is not a plain
 * function component. A block with no component at all is not listed: that
 * one is a warning, not a refusal.
 */
export function listInvalidBlockComponents(
  blocks: readonly BlockDefinition[],
): readonly string[] {
  return blocks
    .filter(
      (block) =>
        block.component !== undefined &&
        !isPlainFunctionComponent(block.component),
    )
    .map((block) => block.key);
}

/**
 * Keeps every block whose `component` is a plain function and reports each
 * block declared without one through `onMissingComponent`, once. A component
 * that is defined but invalid is skipped silently here: the visitor handler
 * refuses it first, so a direct caller of this function simply gets a map
 * without it.
 */
export function createComponentMap(
  blocks: readonly BlockDefinition[],
  hooks?: RenderHooks,
): ComponentMap {
  const map = new Map<string, BlockComponent>();
  for (const block of blocks) {
    const { component } = block;
    if (component === undefined) {
      reportRenderEvent('onMissingComponent', hooks?.onMissingComponent, {
        blockType: block.key,
      });
    } else if (isPlainFunctionComponent(component)) {
      map.set(block.key, component);
    }
  }
  return map;
}
