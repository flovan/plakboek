import type { ReactElement, ReactNode } from 'react';
import { STRINGS } from '../strings.js';

/** The id the dialog is labelled by: the step heading. */
export const LOGIN_HEADING_ID = 'plakboek-login-heading';

/** An input: 44px tall, 16px inline padding, 8px radius, the shared focus
 * ring. Tailwind reads class names as literal text, so each is spelled out. */
export const FIELD_INPUT =
  'box-border h-11 w-full rounded-lg border border-control-border bg-input-fill px-4 text-body text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-[invalid=true]:border-destructive';

/** A field's label: Label weight, 8px above its input. */
export const FIELD_LABEL = 'mb-2 block text-body font-semibold text-text';

/** The one primary button of a step: full width, 44px, accent fill. */
export const PRIMARY_BUTTON =
  'flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-0 bg-accent px-4 text-body font-semibold text-accent-contrast no-underline hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/** A secondary button: same size, surface fill and a control border. */
export const SECONDARY_BUTTON =
  'flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-control-border bg-surface px-4 text-body font-semibold text-text no-underline hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/** A text link, or a button that looks like one: the accent is reserved for
 * these and the primary button. */
export const TEXT_LINK =
  'cursor-pointer border-0 bg-transparent p-0 text-body text-accent underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/** The spacing between the fields of a form. */
export const FIELD_GROUP = 'mb-4';

export type LoginCardProps = {
  readonly heading: string;
  /** One sentence under the heading; absent on a step that has none. */
  readonly body?: ReactNode;
  /** The page "Back to site" leads to. */
  readonly next: string;
  /** The form, and anything else between the body and the secondary actions. */
  readonly children?: ReactNode;
  /** Links centred under the form. */
  readonly secondary?: ReactNode;
};

/**
 * The card every login step shares, inside a native `<dialog>` that is also
 * the scrim: the dialog fills the viewport over the blurred page and the
 * card sits in it. The server renders it `open`, so it paints before any
 * script; the client later closes it and reopens it modally, which makes the
 * rest of the document inert. There is no close button and nothing handles
 * Escape: the dialog is the page, and "Back to site" is the only way out.
 *
 * Geometry lives in the chrome stylesheet (`pk-login`, `pk-card`): centred,
 * at most 400px wide, 32px padding, top-aligned with a scrolling scrim when
 * the card is taller than the viewport, fluid down to 320px.
 */
export function LoginCard(props: LoginCardProps): ReactElement {
  const { heading, body, next, children, secondary } = props;
  return (
    <dialog
      open
      className="pk-login"
      aria-labelledby={LOGIN_HEADING_ID}
      aria-modal="true"
    >
      <div className="pk-card">
        <h1
          id={LOGIN_HEADING_ID}
          tabIndex={-1}
          className="m-0 text-heading font-semibold text-text wrap-anywhere focus:outline-none"
        >
          {heading}
        </h1>
        {body === undefined ? null : (
          <p className="m-0 mt-2 text-body text-text-muted wrap-anywhere">
            {body}
          </p>
        )}
        {children === undefined ? null : <div className="mt-6">{children}</div>}
        {secondary === undefined ? null : (
          <div className="mt-4 flex flex-col items-center gap-2 text-center">
            {secondary}
          </div>
        )}
        <p className="m-0 mt-6 text-center text-body">
          <a href={next} className={TEXT_LINK}>
            {STRINGS['login.backToSite']}
          </a>
        </p>
      </div>
    </dialog>
  );
}
