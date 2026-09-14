import type { MailMessage, MailSender } from './types.js';

export type SmtpOptions = {
  readonly host: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly user?: string;
  readonly pass?: string;
};

export type SmtpTransportConfig = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTLS?: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
  readonly pool: true;
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
};

export type SmtpTransportMessage = {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

export type SmtpTransport = {
  sendMail(message: SmtpTransportMessage): Promise<unknown>;
};

export type CreateSmtpTransport = (
  config: SmtpTransportConfig,
) => SmtpTransport;

export class MailSenderConfigError extends Error {}

const unimplemented: MailSender = {
  send: (_message: MailMessage) => Promise.resolve(),
};

export function createSmtpSender(_options: {
  readonly smtp: SmtpOptions;
  readonly from: string;
  readonly createTransport?: CreateSmtpTransport;
}): MailSender {
  return unimplemented;
}

export function createConsoleSender(_options: {
  readonly from: string;
  readonly nodeEnv?: string;
  readonly write?: (line: string) => void;
}): MailSender {
  return unimplemented;
}

export function createMailSender(_options: {
  readonly smtp?: SmtpOptions;
  readonly from: string;
  readonly nodeEnv?: string;
  readonly write?: (line: string) => void;
  readonly createTransport?: CreateSmtpTransport;
}): { readonly sender: MailSender; readonly kind: 'smtp' | 'console' } {
  return { sender: unimplemented, kind: 'console' };
}
