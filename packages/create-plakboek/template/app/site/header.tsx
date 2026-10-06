import type { ResolvedMenuItem } from '@plakboek/core';
import { MenuLinks } from './menu.tsx';

export type HeaderProps = {
  readonly siteName: string;
  /** The `main` menu, already resolved for this page. */
  readonly items: readonly ResolvedMenuItem[];
};

// The site name links home, followed by the `main` menu. There is no menu
// button: on a narrow screen the row wraps and the menu drops under the name.
// An empty menu leaves just the site name.
export function Header({ siteName, items }: HeaderProps) {
  return (
    <header className="border-b border-border bg-surface-muted py-4">
      <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center justify-between gap-x-6 gap-y-4 px-6">
        <a
          href="/"
          className="min-w-0 text-xl font-semibold text-text wrap-anywhere hover:underline hover:decoration-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {siteName}
        </a>
        {items.length === 0 ? null : (
          <nav aria-label="Main">
            <MenuLinks items={items} gapClass="gap-6" />
          </nav>
        )}
      </div>
    </header>
  );
}
