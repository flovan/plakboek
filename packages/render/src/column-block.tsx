/**
 * The core column cell: one flex-column element holding the blocks of a
 * column. In a live edit render an empty column marks itself and keeps a
 * minimum height so it stays a visible drop target; a visitor render adds
 * nothing beyond the grid cell (D-08).
 */
import { Children, type ReactElement } from 'react';
import type { BlockComponent, BlockComponentProps } from './block-component.js';
import { EDIT_ATTRIBUTE, isLiveEdit } from './live-edit.js';

const EMPTY_COLUMN_MIN_HEIGHT = '96px';

function renderColumn({ children, edit }: BlockComponentProps): ReactElement {
  const empty = isLiveEdit(edit) && Children.count(children) === 0;
  const marker = empty ? { [EDIT_ATTRIBUTE.empty]: '' } : {};
  return (
    <div
      {...edit}
      {...marker}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        ...(empty ? { minHeight: EMPTY_COLUMN_MIN_HEIGHT } : {}),
      }}
    >
      {children}
    </div>
  );
}

export const ColumnBlock: BlockComponent = renderColumn;
