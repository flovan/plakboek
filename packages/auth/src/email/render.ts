/**
 * `renderAuthEmail` -- turns one of the four authentication emails into a
 * `MailMessage` (D-16). The html part is rendered from JSX templates with
 * `renderToStaticMarkup`, so every interpolated value is escaped by React;
 * the plain-text part is derived from that same html, so the two can never
 * say different things.
 *
 * Validity windows arrive in `data` as strings. The caller derives them
 * from the policy constants that set the real token lifetimes, so the copy
 * cannot drift from the policy.
 */
import { convert, type HtmlToTextOptions } from 'html-to-text';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MailMessage } from './types.js';
import { MAGIC_LINK_SUBJECT, MagicLinkEmail } from './templates/magic-link.js';
import {
  RESET_PASSWORD_SUBJECT,
  ResetPasswordEmail,
} from './templates/reset-password.js';
import {
  SET_PASSWORD_SUBJECT,
  SetPasswordEmail,
} from './templates/set-password.js';
import {
  TWO_FACTOR_CODE_SUBJECT,
  TwoFactorCodeEmail,
} from './templates/two-factor-code.js';

export const AUTH_EMAIL_KINDS = Object.freeze([
  'set-password',
  'reset-password',
  'magic-link',
  'two-factor-code',
] as const);

export type AuthEmailKind = (typeof AUTH_EMAIL_KINDS)[number];

/** Plain-text conversion: wrapped at 78 columns (the conventional mail line
 * length), the head and the hidden preheader skipped, and links printed
 * with their url. A link whose text already is the url prints it once. */
const TEXT_OPTIONS: HtmlToTextOptions = Object.freeze({
  wordwrap: 78,
  selectors: [
    { selector: 'head', format: 'skip' },
    { selector: 'div[data-preheader]', format: 'skip' },
    {
      selector: 'a',
      options: { hideLinkHrefIfSameAsText: true },
    },
  ],
});

const KNOWN_KINDS: ReadonlySet<string> = new Set(AUTH_EMAIL_KINDS);

function isAuthEmailKind(kind: unknown): kind is AuthEmailKind {
  return typeof kind === 'string' && KNOWN_KINDS.has(kind);
}

/** Errors name the kind and the field, never a supplied value: the url in
 * particular carries a single-use token. */
function renderError(message: string): Error {
  return new Error(`@plakboek/auth: ${message}`);
}

function readData(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null
    ? Reflect.get(data, key)
    : undefined;
}

function requireText(
  data: unknown,
  kind: AuthEmailKind,
  field: string,
): string {
  const value = readData(data, field);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw renderError(
      `the ${kind} email needs data.${field} as a non-empty string`,
    );
  }
  return value;
}

function optionalText(data: unknown, field: string): string | undefined {
  const value = readData(data, field);
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function requireHttpUrl(data: unknown, kind: AuthEmailKind): string {
  const value = readData(data, 'url');
  const parsed =
    typeof value === 'string' && URL.canParse(value) ? new URL(value) : null;
  if (
    typeof value !== 'string' ||
    parsed === null ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
  ) {
    throw renderError(
      `the ${kind} email needs data.url as an absolute http or https link`,
    );
  }
  return value;
}

function requireWindow(
  data: unknown,
  kind: AuthEmailKind,
  field: string,
): string {
  const value = readData(data, field);
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw renderError(
      `the ${kind} email needs data.${field} as a positive whole number`,
    );
  }
  return value;
}

function withName(
  props: { url: string; expiresInHours: string },
  name: string | undefined,
): { url: string; expiresInHours: string; name?: string } {
  return name === undefined ? props : { ...props, name };
}

function templateFor(
  kind: AuthEmailKind,
  data: unknown,
): { readonly subject: string; readonly element: ReactElement } {
  switch (kind) {
    case 'set-password':
      return {
        subject: SET_PASSWORD_SUBJECT,
        element: createElement(
          SetPasswordEmail,
          withName(
            {
              url: requireHttpUrl(data, kind),
              expiresInHours: requireWindow(data, kind, 'expiresInHours'),
            },
            optionalText(data, 'name'),
          ),
        ),
      };
    case 'reset-password':
      return {
        subject: RESET_PASSWORD_SUBJECT,
        element: createElement(
          ResetPasswordEmail,
          withName(
            {
              url: requireHttpUrl(data, kind),
              expiresInHours: requireWindow(data, kind, 'expiresInHours'),
            },
            optionalText(data, 'name'),
          ),
        ),
      };
    case 'magic-link':
      return {
        subject: MAGIC_LINK_SUBJECT,
        element: createElement(MagicLinkEmail, {
          url: requireHttpUrl(data, kind),
          expiresInMinutes: requireWindow(data, kind, 'expiresInMinutes'),
        }),
      };
    case 'two-factor-code':
      return {
        subject: TWO_FACTOR_CODE_SUBJECT,
        element: createElement(TwoFactorCodeEmail, {
          code: requireText(data, kind, 'code'),
          expiresInMinutes: requireWindow(data, kind, 'expiresInMinutes'),
        }),
      };
  }
}

/**
 * Renders one authentication email. `data.to` becomes the message's
 * recipient; the other fields each kind reads are:
 *
 * - `set-password`, `reset-password`: `url`, `expiresInHours`, optional `name`
 * - `magic-link`: `url`, `expiresInMinutes`
 * - `two-factor-code`: `code`, `expiresInMinutes`
 *
 * Throws for an unknown kind or a missing or malformed field, so a message
 * with an empty link or code is never produced.
 */
export function renderAuthEmail(
  kind: AuthEmailKind,
  data: Record<string, string>,
): MailMessage {
  if (!isAuthEmailKind(kind)) {
    throw renderError(
      `unknown email kind "${String(kind)}"; expected one of ${AUTH_EMAIL_KINDS.join(', ')}`,
    );
  }

  const { subject, element } = templateFor(kind, data);
  const html = `<!DOCTYPE html>${renderToStaticMarkup(element)}`;
  // Nested layout tables leave runs of empty lines; one blank line is
  // enough to separate paragraphs in a plain-text client.
  const text = convert(html, TEXT_OPTIONS)
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

  return {
    to: optionalText(data, 'to') ?? '',
    subject,
    html,
    text,
  };
}
