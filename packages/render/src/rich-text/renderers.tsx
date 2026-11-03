/**
 * The renderer map: one component per rich-text node and mark, plus the CTA
 * row. The visitor page, the editor frame and the editor's node views all
 * render stored text through the same map, so a host overrides a renderer
 * once (`defineTextTheme({ renderers })`) and the caret sits in the host's own
 * styling.
 *
 * A renderer is a plain function of its props. It must render `children`
 * inside exactly one element: that single element is what lets the editor
 * derive a faithful shell for the node. A renderer that needs a wrapper adds
 * it around that one element, never beside it.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { HeadingLevel, TextAlign } from '@plakboek/content/rich-text';

type LinkTargetValue = '_blank' | null;

export type ParagraphRendererProps = {
  readonly children: ReactNode;
  /** `null` unless the author aligned the paragraph. */
  readonly textAlign: TextAlign | null;
};

export type HeadingRendererProps = {
  /** 2, 3 or 4: the title, the heading and the subheading. */
  readonly level: HeadingLevel;
  readonly textAlign: TextAlign | null;
  readonly children: ReactNode;
};

export type BulletListRendererProps = { readonly children: ReactNode };

export type OrderedListRendererProps = {
  /** The first number; 1 unless the author started the list elsewhere. */
  readonly start: number;
  readonly children: ReactNode;
};

export type ListItemRendererProps = { readonly children: ReactNode };

export type BlockquoteRendererProps = { readonly children: ReactNode };

/** A divider carries no props. */
export type HorizontalRuleRendererProps = object;

/** A hard line break carries no props. */
export type HardBreakRendererProps = object;

export type BoldRendererProps = { readonly children: ReactNode };
export type ItalicRendererProps = { readonly children: ReactNode };
export type UnderlineRendererProps = { readonly children: ReactNode };
export type StrikeRendererProps = { readonly children: ReactNode };

export type LinkRendererProps = {
  /** A target that already passed the href policy; never empty. */
  readonly href: string;
  readonly target: LinkTargetValue;
  readonly children: ReactNode;
};

/** Exactly one of `token` and `value` is set. */
export type TextColorRendererProps = {
  /** A palette token; the default renderer reads `var(--color-<token>)`. */
  readonly token: string | null;
  /** A literal hex colour that passed the strict check. */
  readonly value: string | null;
  readonly children: ReactNode;
};

/** Exactly one of `token` and `value` is set. */
export type TextSizeRendererProps = {
  /** A size token; the default renderer reads `var(--text-<token>)`. */
  readonly token: string | null;
  /** A literal px size that passed the strict check. */
  readonly value: string | null;
  readonly children: ReactNode;
};

export type CtaRendererProps = {
  readonly label: string;
  /** `null` when the target is unresolved: the editor's unfinished CTA. */
  readonly href: string | null;
  readonly target: LinkTargetValue;
  /** A key of the theme's CTA variants. */
  readonly variant: string;
};

export type CtaRowRendererProps = { readonly children: ReactNode };

export type TextRenderers = {
  readonly paragraph: (props: ParagraphRendererProps) => ReactNode;
  readonly heading: (props: HeadingRendererProps) => ReactNode;
  readonly bulletList: (props: BulletListRendererProps) => ReactNode;
  readonly orderedList: (props: OrderedListRendererProps) => ReactNode;
  readonly listItem: (props: ListItemRendererProps) => ReactNode;
  readonly blockquote: (props: BlockquoteRendererProps) => ReactNode;
  readonly horizontalRule: (props: HorizontalRuleRendererProps) => ReactNode;
  readonly hardBreak: (props: HardBreakRendererProps) => ReactNode;
  readonly bold: (props: BoldRendererProps) => ReactNode;
  readonly italic: (props: ItalicRendererProps) => ReactNode;
  readonly underline: (props: UnderlineRendererProps) => ReactNode;
  readonly strike: (props: StrikeRendererProps) => ReactNode;
  readonly link: (props: LinkRendererProps) => ReactNode;
  readonly textColor: (props: TextColorRendererProps) => ReactNode;
  readonly textSize: (props: TextSizeRendererProps) => ReactNode;
  readonly cta: (props: CtaRendererProps) => ReactNode;
  readonly ctaRow: (props: CtaRowRendererProps) => ReactNode;
};

function alignStyle(textAlign: TextAlign | null): CSSProperties | undefined {
  return textAlign === null ? undefined : { textAlign };
}

/** `rel` is always added for a new tab, so the opener is never exposed. */
function relFor(target: LinkTargetValue): string | undefined {
  return target === '_blank' ? 'noopener noreferrer' : undefined;
}

export const DEFAULT_TEXT_RENDERERS: TextRenderers = Object.freeze({
  paragraph: ({ children, textAlign }) => (
    <p style={alignStyle(textAlign)}>{children}</p>
  ),
  heading: ({ level, textAlign, children }) => {
    const Tag = level === 3 ? 'h3' : level === 4 ? 'h4' : 'h2';
    return <Tag style={alignStyle(textAlign)}>{children}</Tag>;
  },
  bulletList: ({ children }) => <ul>{children}</ul>,
  orderedList: ({ start, children }) => (
    <ol start={start === 1 ? undefined : start}>{children}</ol>
  ),
  listItem: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => <blockquote>{children}</blockquote>,
  horizontalRule: () => <hr />,
  hardBreak: () => <br />,
  bold: ({ children }) => <strong>{children}</strong>,
  italic: ({ children }) => <em>{children}</em>,
  underline: ({ children }) => <u>{children}</u>,
  strike: ({ children }) => <s>{children}</s>,
  link: ({ href, target, children }) => (
    <a href={href} target={target ?? undefined} rel={relFor(target)}>
      {children}
    </a>
  ),
  textColor: ({ token, value, children }) => (
    <span
      style={{
        color: token === null ? (value ?? undefined) : `var(--color-${token})`,
      }}
    >
      {children}
    </span>
  ),
  textSize: ({ token, value, children }) => (
    <span
      style={{
        fontSize:
          token === null ? (value ?? undefined) : `var(--text-${token})`,
      }}
    >
      {children}
    </span>
  ),
  cta: ({ label, href, target, variant }) =>
    href === null ? (
      <span data-variant={variant}>{label}</span>
    ) : (
      <a
        href={href}
        target={target ?? undefined}
        rel={relFor(target)}
        data-variant={variant}
      >
        {label}
      </a>
    ),
  ctaRow: ({ children }) => <div data-cta-row="">{children}</div>,
});
