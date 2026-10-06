import type { ResolvedMenuItem } from '@plakboek/core';

const linkClass =
  'min-h-11 inline-flex items-center text-sm font-semibold text-text wrap-anywhere hover:underline hover:decoration-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const currentClass =
  'underline decoration-accent decoration-2 underline-offset-4';

export type MenuLinksProps = {
  readonly items: readonly ResolvedMenuItem[];
  /** Spacing between the links; the header and footer differ. */
  readonly gapClass: string;
};

// The one place a menu is rendered. The header and the footer both call it, so
// a change to how links look or which one is current happens here.
export function MenuLinks({ items, gapClass }: MenuLinksProps) {
  return (
    <ul className={`flex flex-wrap ${gapClass}`}>
      {items.map((item) => (
        <li key={`${item.href}\n${item.label}`} className="min-w-0">
          <a
            href={item.href}
            aria-current={item.current ? 'page' : undefined}
            className={
              item.current ? `${linkClass} ${currentClass}` : linkClass
            }
          >
            {item.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
