import type { ReactElement, ReactNode } from 'react';

/**
 * The inline icons chrome uses: six for the shell, twenty for structural
 * editing and nineteen for text editing.
 * Each draws in `currentColor`, is hidden
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

/** Edit mode: a pointer arrow. */
export function EditPointerIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M5 3l6 16 2.5-6.5L20 10z" />
    </Icon>
  );
}

/** Interact mode: a pointing hand. */
export function InteractHandIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10" />
      <path d="M12 10a1.5 1.5 0 0 1 3 0v1" />
      <path d="M15 11a1.5 1.5 0 0 1 3 0v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.5L9 15" />
    </Icon>
  );
}

/** Undo: an arrow curving back. */
export function UndoIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </Icon>
  );
}

/** Redo: an arrow curving forward. */
export function RedoIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 0 0 0 12h3" />
    </Icon>
  );
}

/** The drag handle: two columns of three dots. */
export function GripIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </Icon>
  );
}

/** A chevron pointing right: the disclosure toggle of a Page structure row. */
export function ChevronRightIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M9 6l6 6-6 6" />
    </Icon>
  );
}

/** An arrow pointing up. */
export function ArrowUpIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </Icon>
  );
}

/** An arrow pointing down. */
export function ArrowDownIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M12 5v14" />
      <path d="M19 12l-7 7-7-7" />
    </Icon>
  );
}

/** An arrow pointing left. */
export function ArrowLeftIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M19 12H5" />
      <path d="M12 5l-7 7 7 7" />
    </Icon>
  );
}

/** An arrow pointing right. */
export function ArrowRightIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </Icon>
  );
}

/** Add: a plus sign. */
export function PlusIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

/** Duplicate: a page in front of another. */
export function DuplicateIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h8a1 1 0 0 1 1 1" />
    </Icon>
  );
}

/** Properties: two sliders. */
export function PropertiesIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M4 7h10" />
      <path d="M18 7h2" />
      <circle cx="16" cy="7" r="2" />
      <path d="M4 17h2" />
      <path d="M10 17h10" />
      <circle cx="8" cy="17" r="2" />
    </Icon>
  );
}

/** Delete: a bin with a lid. */
export function TrashIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Icon>
  );
}

/** Done: a check mark. */
export function CheckIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Icon>
  );
}

/** Columns: a box split in two. */
export function ColumnsIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </Icon>
  );
}

/** Blocks: four squares. */
export function BlocksIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </Icon>
  );
}

/** A lock: a padlock. */
export function LockIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

/** Close: a cross. */
export function CloseIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Icon>
  );
}

/** Search: a magnifying glass. */
export function SearchIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </Icon>
  );
}

/** Bold: a heavy letter B. */
export function BoldIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
      <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
    </Icon>
  );
}

/** Italic: a slanted letter between two bars. */
export function ItalicIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M10 5h8" />
      <path d="M6 19h8" />
      <path d="M15 5l-6 14" />
    </Icon>
  );
}

/** Underline: a letter U above a line. */
export function UnderlineIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M7 4v7a5 5 0 0 0 10 0V4" />
      <path d="M5 21h14" />
    </Icon>
  );
}

/** Strikethrough: a line through a letter. */
export function StrikethroughIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M4 12h16" />
      <path d="M16.5 7.5C16 6 14.5 5 12 5c-2.5 0-4.5 1.2-4.5 3.2 0 1.4 1 2.3 2.5 2.8" />
      <path d="M14 13c1.6.5 2.5 1.4 2.5 2.8C16.5 17.8 14.5 19 12 19c-2.5 0-4.2-1.1-4.8-3" />
    </Icon>
  );
}

/** Bulleted list: dots beside lines. */
export function ListBulletIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4 6h.01" />
      <path d="M4 12h.01" />
      <path d="M4 18h.01" />
    </Icon>
  );
}

/** Numbered list: ordinal marks beside lines. */
export function ListNumberedIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M11 6h9" />
      <path d="M11 12h9" />
      <path d="M11 18h9" />
      <path d="M4 5l1.5-1v4" />
      <path d="M3.5 13.5a1.5 1.5 0 1 1 2.6 1L3.5 17.5H6.5" />
    </Icon>
  );
}

/** Link: two joined chain links. */
export function LinkIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Icon>
  );
}

/** Quote: an opening quotation mark. */
export function QuoteIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M5 17v-4a5 5 0 0 1 5-5" />
      <path d="M5 13h4v4H5z" />
      <path d="M14 17v-4a5 5 0 0 1 5-5" />
      <path d="M14 13h4v4h-4z" />
    </Icon>
  );
}

/** Divider: a horizontal rule between two blocks. */
export function DividerIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M4 12h16" />
      <path d="M8 6h8" />
      <path d="M8 18h8" />
    </Icon>
  );
}

/** Button: a rounded button outline holding a line of text. */
export function CtaIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <rect x="3" y="7" width="18" height="10" rx="5" />
      <path d="M9 12h6" />
    </Icon>
  );
}

/** Chevron down: opens a menu. */
export function ChevronDownIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

/** Palette: a painter's palette with colour dabs. */
export function PaletteIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.5-1-1.5-1-3 0-1 .8-2 2-2h2.5A3.5 3.5 0 0 0 21 10.5 8 8 0 0 0 12 3z" />
      <path d="M7.5 11h.01" />
      <path d="M10 7.5h.01" />
      <path d="M14.5 7.5h.01" />
    </Icon>
  );
}

/** Align left: lines flush to the left edge. */
export function AlignLeftIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M4 6h16" />
      <path d="M4 10h10" />
      <path d="M4 14h16" />
      <path d="M4 18h10" />
    </Icon>
  );
}

/** Align center: lines centred on the middle. */
export function AlignCenterIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M4 6h16" />
      <path d="M7 10h10" />
      <path d="M4 14h16" />
      <path d="M7 18h10" />
    </Icon>
  );
}

/** Align right: lines flush to the right edge. */
export function AlignRightIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M4 6h16" />
      <path d="M10 10h10" />
      <path d="M4 14h16" />
      <path d="M10 18h10" />
    </Icon>
  );
}

/** Reset: a counter-clockwise arrow. */
export function ResetIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M4 5v5h5" />
      <path d="M4.6 14a8 8 0 1 0 1.8-8.4L4 10" />
    </Icon>
  );
}

/** External: an arrow leaving a box, for links that open elsewhere. */
export function ExternalIcon({
  size = 16,
  className,
}: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </Icon>
  );
}

/** Page: a sheet with a folded corner. */
export function PageIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M14 3v5h5" />
    </Icon>
  );
}

/** More: three dots. */
export function MoreIcon({ size = 16, className }: IconProps): ReactElement {
  return (
    <Icon size={size} className={className}>
      <path d="M5 12h.01" />
      <path d="M12 12h.01" />
      <path d="M19 12h.01" />
    </Icon>
  );
}
