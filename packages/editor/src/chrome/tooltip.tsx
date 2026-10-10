import type { ReactElement, ReactNode } from 'react';

export type TooltipProps = {
  /** The text shown. The control it labels keeps its own accessible name, so
   * the tooltip is decoration for sighted users and is hidden from assistive
   * technology. */
  readonly label: string;
  readonly children: ReactNode;
  /** Classes of the wrapper, for controls that are not inline-sized. */
  readonly className?: string;
  /** When false the wrapper stays and no tooltip can show: a name that is not
   * clamped needs none. */
  readonly enabled?: boolean;
};

/**
 * A tooltip drawn by CSS alone, so it needs no script, no portal and no
 * focus management inside a shadow root. It sits to the right of what it
 * labels with an 8px gap, shows after 300ms of hovering and at once when the
 * control takes focus, and hides at once. It has no motion. Focus is matched
 * with `:focus-within`: the `:has(:focus-visible)` form did not show the
 * tooltip in WebKit.
 */
export function Tooltip(props: TooltipProps): ReactElement {
  const { label, children, className = 'inline-flex', enabled = true } = props;
  return (
    <span className={`group relative ${className}`}>
      {children}
      {enabled ? (
        <span
          aria-hidden="true"
          data-tooltip=""
          className="pointer-events-none invisible absolute top-0 bottom-0 left-full z-10 my-auto ml-2 h-fit w-max max-w-[240px] rounded-sm bg-text px-2 py-1 text-caption font-semibold wrap-anywhere text-surface opacity-0 transition-[opacity,visibility] duration-0 group-hover:visible group-hover:opacity-100 group-hover:delay-300 group-focus-within:visible group-focus-within:opacity-100 group-focus-within:delay-0"
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
