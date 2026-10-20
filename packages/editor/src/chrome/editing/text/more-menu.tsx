import type { ReactElement } from 'react';
import { CheckIcon, MoreIcon } from '../../icons.js';
import { STRINGS } from '../../strings.js';
import type { Rove } from './crumbs.js';
import { MENU_ROW, ToolbarMenu } from './toolbar-menu.js';

/** A toggle that moved into the More menu: its name, icon and state. */
export type MoreEntry = {
  readonly id: string;
  readonly name: string;
  readonly icon: ReactElement;
  readonly pressed: boolean;
  readonly run: () => void;
};

export type MoreMenuProps = {
  readonly entries: readonly MoreEntry[];
  readonly onReturn: () => void;
  readonly rove: Rove;
  readonly tooltipSide: 'top' | 'bottom';
};

/**
 * The More button of a narrow frame: holds the toggles that did not fit, as
 * menu items that keep their pressed state (`menuitemcheckbox`).
 */
export function MoreMenu(props: MoreMenuProps): ReactElement | null {
  const { entries, onReturn, rove, tooltipSide } = props;
  if (entries.length === 0) return null;
  return (
    <ToolbarMenu
      id="more"
      label={STRINGS['text.more']}
      icon={<MoreIcon />}
      rove={rove}
      tooltipSide={tooltipSide}
      onReturn={onReturn}
    >
      {(choose) =>
        entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={entry.pressed}
            tabIndex={-1}
            className={MENU_ROW}
            data-more-item={entry.id}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={choose(entry.run)}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {entry.icon}
            </span>
            <span className="flex-1">{entry.name}</span>
            {entry.pressed ? <CheckIcon /> : null}
          </button>
        ))
      }
    </ToolbarMenu>
  );
}
