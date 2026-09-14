/**
 * Primitives every transactional email is built from (D-16). The markup is
 * the conservative shape mail clients agree on: a centred fixed-width
 * table, inline styles only (many clients strip `<style>` blocks), no web
 * fonts, and a button whose colour sits on its table cell so Outlook still
 * draws it. Every table is `role="presentation"` so screen readers do not
 * announce layout grids as data tables.
 */
import type { CSSProperties, ReactNode } from 'react';

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const COLOR = Object.freeze({
  page: '#f4f4f5',
  surface: '#ffffff',
  text: '#27272a',
  muted: '#71717a',
  border: '#e4e4e7',
  accent: '#18181b',
  accentText: '#ffffff',
});

const CONTAINER_WIDTH = 600;

type PresentationTableProps = {
  readonly width?: string;
  readonly style?: CSSProperties;
  readonly children: ReactNode;
};

/** A layout table with every legacy attribute clients still look at. */
function PresentationTable({ width, style, children }: PresentationTableProps) {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      {...(width !== undefined ? { width } : {})}
      {...(style !== undefined ? { style } : {})}
    >
      <tbody>{children}</tbody>
    </table>
  );
}

type EmailDocumentProps = {
  readonly title: string;
  readonly lang?: string;
  readonly children: ReactNode;
};

export function EmailDocument({
  title,
  lang = 'en',
  children,
}: EmailDocumentProps) {
  return (
    <html lang={lang}>
      <head>
        <meta httpEquiv="Content-Type" content="text/html; charset=UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title}</title>
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          width: '100%',
          backgroundColor: COLOR.page,
          fontFamily: FONT_STACK,
          color: COLOR.text,
        }}
      >
        {children}
      </body>
    </html>
  );
}

/** `mso-hide` is an Outlook-only property React's CSS types do not know;
 * React still serialises it to `mso-hide:all`. */
const PREHEADER_STYLE: CSSProperties & { readonly msoHide: string } = {
  display: 'none',
  fontSize: 1,
  lineHeight: 1,
  maxHeight: 0,
  maxWidth: 0,
  opacity: 0,
  overflow: 'hidden',
  msoHide: 'all',
};

/** Preview text shown next to the subject in an inbox list, hidden in the
 * opened message. `data-preheader` lets the plain-text conversion skip it. */
export function Preheader({ children }: { readonly children: string }) {
  return (
    <div data-preheader="" style={PREHEADER_STYLE}>
      {children}
    </div>
  );
}

/** The centred 600px column, shrinking to the viewport on small screens. */
export function Container({ children }: { readonly children: ReactNode }) {
  return (
    <PresentationTable
      width="100%"
      style={{ width: '100%', backgroundColor: COLOR.page }}
    >
      <tr>
        <td align="center" style={{ padding: '32px 12px' }}>
          <PresentationTable
            width={String(CONTAINER_WIDTH)}
            style={{
              width: CONTAINER_WIDTH,
              maxWidth: '100%',
              backgroundColor: COLOR.surface,
              border: `1px solid ${COLOR.border}`,
              borderRadius: 8,
            }}
          >
            <tr>
              <td style={{ padding: 32, textAlign: 'left' }}>{children}</td>
            </tr>
          </PresentationTable>
        </td>
      </tr>
    </PresentationTable>
  );
}

type ParagraphProps = {
  readonly tone?: 'body' | 'muted';
  readonly style?: CSSProperties;
  readonly children: ReactNode;
};

export function Paragraph({ tone = 'body', style, children }: ParagraphProps) {
  return (
    <p
      style={{
        margin: '0 0 16px',
        fontSize: tone === 'muted' ? 13 : 16,
        lineHeight: tone === 'muted' ? '20px' : '24px',
        color: tone === 'muted' ? COLOR.muted : COLOR.text,
        ...style,
      }}
    >
      {children}
    </p>
  );
}

/** A link styled as a button. The background colour is set on the table
 * cell as well as the link, so clients that ignore padding on inline
 * elements still show a solid, clickable block. */
export function Button({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  return (
    <PresentationTable style={{ margin: '8px 0 24px' }}>
      <tr>
        <td
          align="center"
          style={{ borderRadius: 6, backgroundColor: COLOR.accent }}
        >
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              padding: '12px 24px',
              border: `1px solid ${COLOR.accent}`,
              borderRadius: 6,
              backgroundColor: COLOR.accent,
              color: COLOR.accentText,
              fontFamily: FONT_STACK,
              fontSize: 16,
              fontWeight: 600,
              lineHeight: '20px',
              textDecoration: 'none',
            }}
          >
            {children}
          </a>
        </td>
      </tr>
    </PresentationTable>
  );
}

export function Divider() {
  return (
    <PresentationTable width="100%" style={{ width: '100%' }}>
      <tr>
        <td style={{ padding: '8px 0 24px' }}>
          <div
            style={{
              borderTop: `1px solid ${COLOR.border}`,
              fontSize: 1,
              lineHeight: '1px',
            }}
          />
        </td>
      </tr>
    </PresentationTable>
  );
}

/** Shown under the button so a reader whose client blocks it, or who reads
 * the plain-text part, can still open the link. The link text is the url
 * itself, which the plain-text conversion prints once, on its own line. */
export function LinkFallback({ href }: { readonly href: string }) {
  return (
    <>
      <Paragraph tone="muted" style={{ margin: '0 0 4px' }}>
        If the button does not work, copy this link into your browser:
      </Paragraph>
      <Paragraph tone="muted" style={{ wordBreak: 'break-all' }}>
        <a href={href} style={{ color: COLOR.muted }}>
          {href}
        </a>
      </Paragraph>
    </>
  );
}

type AuthEmailLayoutProps = {
  readonly title: string;
  readonly preview: string;
  readonly children: ReactNode;
};

/** The shell every authentication email renders through. */
export function AuthEmailLayout({
  title,
  preview,
  children,
}: AuthEmailLayoutProps) {
  return (
    <EmailDocument title={title}>
      <Preheader>{preview}</Preheader>
      <Container>
        {children}
        <Divider />
        <Paragraph tone="muted" style={{ margin: 0 }}>
          This is an automated message about your account. Replies to this
          address are not read.
        </Paragraph>
      </Container>
    </EmailDocument>
  );
}

/** "1 hour" / "48 hours": the count is passed in as a string by the caller,
 * derived from the policy constant that sets the window. */
export function pluralise(count: string, unit: string): string {
  return `${count} ${count === '1' ? unit : `${unit}s`}`;
}
