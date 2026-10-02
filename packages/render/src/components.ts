/**
 * The block-type to component map (D-09). `@plakboek/pages` keeps
 * `BlockDefinition.component` opaque; this module narrows it, once, when a
 * handler is created. The request path reads this map and never the
 * process-wide block registry, so two handlers over two configs in one
 * process stay independent (D-04).
 */
import type { BlockDefinition } from '@plakboek/pages';
import type { BlockComponent } from './block-component.js';

export type ComponentMap = ReadonlyMap<string, BlockComponent>;

/** Keeps every block whose `component` is a plain function. */
export function createComponentMap(
  blocks: readonly BlockDefinition[],
): ComponentMap {
  const map = new Map<string, BlockComponent>();
  for (const block of blocks) {
    const { component } = block;
    if (typeof component === 'function') {
      map.set(block.key, component as BlockComponent);
    }
  }
  return map;
}
