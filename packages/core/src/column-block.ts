/**
 * The one core-owned column block (D-02). Every installation registers it
 * after the host's own blocks; a host never declares it and cannot replace
 * it, because the column rules in `@plakboek/pages` (a section holds columns,
 * a column sits only under a section) are keyed on its kind.
 */
import { ColumnBlock } from '@plakboek/render';
import type { HostBlockDefinition } from './types.js';

export const CORE_COLUMN_KEY = 'column';

export const CORE_COLUMN_BLOCK: HostBlockDefinition = {
  key: CORE_COLUMN_KEY,
  kind: 'column',
  editor: { label: 'Column' },
  schemaVersion: 1,
  properties: {},
  placement: { allowedChildren: 'any' },
  component: ColumnBlock,
};
