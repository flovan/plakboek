import type { ResolvedMenuItem } from '@plakboek/core';
import { MenuLinks } from './menu.tsx';

export type FooterProps = {
  readonly siteName: string;
  /** The same `main` menu the header shows. */
  readonly items: readonly ResolvedMenuItem[];
  readonly year: number;
};

// The footer repeats the menu, then a copyright line. The extra space under
// it keeps the editor toolbar, fixed at the bottom right, off the links.
export function Footer({ siteName, items, year }: FooterProps) {
  return (
    <footer className="border-t border-border bg-surface-muted pt-8 pb-16">
      <div className="mx-auto w-full max-w-[1120px] px-6">
        {items.length === 0 ? null : (
          <nav aria-label="Footer">
            <MenuLinks items={items} gapClass="gap-x-6 gap-y-2" />
          </nav>
        )}
        <p
          className={`${items.length === 0 ? '' : 'mt-4 '}text-sm text-text-muted wrap-anywhere`}
        >
          {`© ${year} ${siteName}`}
        </p>
      </div>
    </footer>
  );
}
