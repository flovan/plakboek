import type { MailMessage } from './types.js';

export const AUTH_EMAIL_KINDS = Object.freeze([
  'set-password',
  'reset-password',
  'magic-link',
  'two-factor-code',
] as const);

export type AuthEmailKind = (typeof AUTH_EMAIL_KINDS)[number];

export function renderAuthEmail(
  _kind: AuthEmailKind,
  _data: Record<string, string>,
): MailMessage {
  return { to: '', subject: '', html: '', text: '' };
}
