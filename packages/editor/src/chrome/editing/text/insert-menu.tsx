import type { ReactElement } from 'react';
import type { InsertItem } from '../../../client/text/insert-items.js';
import { PlusIcon } from '../../icons.js';
import { STRINGS } from '../../strings.js';
import type { Rove } from './crumbs.js';
import { InsertIcon } from './insert-icons.js';
import { MENU_ROW, ToolbarMenu } from './toolbar-menu.js';

export type InsertMenuProps = {
  /** What the theme lets be inserted from the bar: Quote and Divider (Button joins with its node). */
  readonly items: readonly InsertItem[];
  readonly onChoose: (item: InsertItem) => void;
  readonly onReturn: () => void;
  readonly rove: Rove;
  readonly tooltipSide: 'top' | 'bottom';
};

/**
 * The Insert button: opens a 200px menu of the blocks the theme allows. With
 * nothing insertable the caller does not render it.
 */
export function InsertMenu(props: InsertMenuProps): ReactElement | null {
  const { items, onChoose, onReturn, rove, tooltipSide } = props;
  if (items.length === 0) return null;
  return (
    <ToolbarMenu
      id="insert"
      label={STRINGS['text.insert']}
      icon={<PlusIcon />}
      rove={rove}
      tooltipSide={tooltipSide}
      onReturn={onReturn}
    >
      {(choose) =>
        items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={MENU_ROW}
            data-insert-item={item.id}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={choose(() => {
              onChoose(item);
            })}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <InsertIcon id={item.id} />
            </span>
            {item.label}
          </button>
        ))
      }
    </ToolbarMenu>
  );
}
