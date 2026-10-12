import type { ReactElement, ReactNode } from 'react';

/**
 * The six inline icons chrome uses. Each draws in `currentColor`, is hidden
 * from assistive technology (the control that holds it carries the name), and
 * comes in the two sizes the design allows: 16px inside buttons, 20px
 * everywhere else. A later phase may swap in an icon library behind this
 * module.
 */
export type IconSize = 16 | 20;

type IconProps = {
  readonly size?: IconSize;
  readonly className?: string;
};

function Icon(props: {
  readonly size: IconSize;
  readonly className: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={props.size}
      height={props.size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={props.className}
    >
      {props.children}
    </svg>
  );
}

/** The framed layout: a page inside a stage. */
export function FrameIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="7" y="8" width="10" height="8" rx="1" />
    </Icon>
  );
}

/** The full-width layout: four corners reaching outwards. */
export function ExpandIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </Icon>
  );
}

/** Leave edit mode: an arrow leaving a page. */
export function ExitIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Icon>
  );
}

/** End the session: an arrow leaving a door. */
export function LogOutIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" />
      <path d="M15 8l4 4-4 4" />
      <path d="M19 12H9" />
    </Icon>
  );
}

/**
 * A rotating arc. `animated` false renders the same arc without rotation,
 * which is what a person who asked for reduced motion sees; the rotation
 * itself only applies when the browser allows motion.
 */
export function SpinnerIcon({
  size = 16,
  className,
  animated = true,
}: IconProps & { readonly animated?: boolean }): ReactElement {
  const classes = [animated ? 'motion-safe:animate-spin' : '', className ?? '']
    .filter((name) => name.length > 0)
    .join(' ');
  return (
    <Icon size={size} className={classes.length > 0 ? classes : undefined}>
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </Icon>
  );
}

/** The error box: a circle with an exclamation mark. */
export function AlertIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16.5h.01" />
    </Icon>
  );
}
