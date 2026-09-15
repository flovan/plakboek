/**
 * `MailSender` implementations (D-15) and the configuration-driven choice
 * between them. SMTP is the only real transport: it serves a dedicated
 * mailbox on a customer's own mail server and any transactional relay's
 * SMTP endpoint alike. The console sender exists so a developer without a
 * mail server can still run every flow, and it can never be selected in
 * production.
 *
 * The host reads its environment and passes plain values in; nothing here
 * reads SMTP settings from `process.env`.
 */
import { createTransport as createNodemailerTransport } from 'nodemailer';
import { MailSendError, type MailMessage, type MailSender } from './types.js';

/** SMTP settings as the host supplies them. `user` and `pass` come as a
 * pair or not at all; an unauthenticated internal relay omits both. */
export type SmtpOptions = {
  readonly host: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly user?: string;
  readonly pass?: string;
};

/** The exact configuration handed to the transport factory. */
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

/** Builds a transport from its configuration. Defaults to nodemailer's
 * `createTransport`; tests inject a recording fake so no socket is opened. */
export type CreateSmtpTransport = (
  config: SmtpTransportConfig,
) => SmtpTransport;

export type MailSenderKind = 'smtp' | 'console';

export type CreateSmtpSenderOptions = {
  readonly smtp: SmtpOptions;
  readonly from: string;
  readonly createTransport?: CreateSmtpTransport;
};

export type CreateConsoleSenderOptions = {
  readonly from: string;
  /** Defaults to `process.env.NODE_ENV`. */
  readonly nodeEnv?: string;
  /** Where the message goes. Defaults to `console.info`. */
  readonly write?: (line: string) => void;
};

export type CreateMailSenderOptions = {
  readonly smtp?: SmtpOptions;
  readonly from: string;
  readonly nodeEnv?: string;
  readonly write?: (line: string) => void;
  readonly createTransport?: CreateSmtpTransport;
};

/** Thrown for invalid mail sender options. Messages name the field that
 * failed and what it must be, never the supplied value, so a credential,
 * host or address cannot reach a log through here. */
export class MailSenderConfigError extends Error {
  constructor(message: string) {
    super(`@plakboek/auth: ${message}`);
    this.name = 'MailSenderConfigError';
  }
}

const STARTTLS_PORT = 587;
const IMPLICIT_TLS_PORT = 465;
const MAX_PORT = 65_535;

/** Bounds on every SMTP round trip, so a hung or unreachable server fails
 * the send instead of holding the caller open. */
const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 30_000;

/** Control characters (CR and LF among them) would let a `from` value
 * smuggle extra headers into every message. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertFromAddress(from: unknown): void {
  const parts = typeof from === 'string' ? from.split('@') : [];
  const [local, domain] = parts;
  if (
    typeof from !== 'string' ||
    parts.length !== 2 ||
    !isNonEmptyString(local?.trim()) ||
    !isNonEmptyString(domain?.trim()) ||
    hasControlCharacter(from)
  ) {
    throw new MailSenderConfigError(
      'from must be a single email address with a local part and a domain, such as "noreply@example.com"',
    );
  }
}

function assertSmtpOptions(smtp: SmtpOptions): void {
  const { host, port, secure, user, pass } = smtp;

  if (!isNonEmptyString(host) || host.trim().length === 0) {
    throw new MailSenderConfigError('smtp.host must be a non-empty hostname');
  }

  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > MAX_PORT)
  ) {
    throw new MailSenderConfigError(
      `smtp.port must be an integer between 1 and ${MAX_PORT}`,
    );
  }

  if (secure !== undefined && typeof secure !== 'boolean') {
    throw new MailSenderConfigError('smtp.secure must be a boolean');
  }

  const hasUser = user !== undefined;
  const hasPass = pass !== undefined;
  if (hasUser !== hasPass) {
    throw new MailSenderConfigError(
      'smtp.user and smtp.pass must be supplied together or not at all',
    );
  }
  if (hasUser && (!isNonEmptyString(user) || !isNonEmptyString(pass))) {
    throw new MailSenderConfigError(
      'smtp.user and smtp.pass must be non-empty strings when supplied',
    );
  }
}

/** Implicit TLS when `secure`; otherwise STARTTLS is mandatory, so a server
 * that cannot upgrade fails the send rather than receiving credentials or
 * links in clear text. There is deliberately no plaintext option. */
function buildTransportConfig(smtp: SmtpOptions): SmtpTransportConfig {
  const secure = smtp.secure ?? false;
  const common = {
    host: smtp.host.trim(),
    pool: true,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    ...(smtp.user !== undefined && smtp.pass !== undefined
      ? { auth: { user: smtp.user, pass: smtp.pass } }
      : {}),
  } as const;

  if (secure) {
    return {
      ...common,
      port: smtp.port ?? IMPLICIT_TLS_PORT,
      secure: true,
    };
  }

  return {
    ...common,
    port: smtp.port ?? STARTTLS_PORT,
    secure: false,
    requireTLS: true,
  };
}

function defaultCreateTransport(config: SmtpTransportConfig): SmtpTransport {
  return createNodemailerTransport({ ...config });
}

/**
 * Builds an SMTP-backed `MailSender`. The transport is created once, here,
 * and pools its connections across sends. A failed send rejects with
 * `MailSendError`, which names only the recipient's domain; the transport's
 * own error, which may quote the address, rides along as `cause`.
 */
export function createSmtpSender(options: CreateSmtpSenderOptions): MailSender {
  assertFromAddress(options.from);
  assertSmtpOptions(options.smtp);

  const { from } = options;
  const createTransport = options.createTransport ?? defaultCreateTransport;
  const transport = createTransport(buildTransportConfig(options.smtp));

  return {
    async send(message: MailMessage): Promise<void> {
      try {
        await transport.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        });
      } catch (error) {
        throw new MailSendError(message.to, { cause: error });
      }
    },
  };
}

function defaultWrite(line: string): void {
  // oxlint-disable-next-line no-console -- the console sender is the documented development fallback when no SMTP host is configured; a host overrides `write` to route elsewhere
  console.info(line);
}

/**
 * Builds a development-only `MailSender` that prints each message instead
 * of delivering it, plain-text body included, so a developer can copy the
 * link out of the output. It refuses to exist in production.
 */
export function createConsoleSender(
  options: CreateConsoleSenderOptions,
): MailSender {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === 'production') {
    throw new MailSenderConfigError(
      'the console mail sender cannot be used in production; a production installation must supply SMTP configuration (smtp.host)',
    );
  }
  assertFromAddress(options.from);

  const { from } = options;
  const write = options.write ?? defaultWrite;

  return {
    send(message: MailMessage): Promise<void> {
      write(
        [
          '[@plakboek/auth] development mail (console sender, not delivered)',
          `From: ${from}`,
          `To: ${message.to}`,
          `Subject: ${message.subject}`,
          '',
          message.text,
        ].join('\n'),
      );
      return Promise.resolve();
    },
  };
}

/**
 * Chooses the sender from configuration: SMTP when `smtp.host` is a
 * non-blank string, the console sender otherwise -- except in production,
 * where missing SMTP configuration is an error. `kind` reports the choice
 * so a deployment can assert it rather than discover it from an empty
 * inbox.
 */
export function createMailSender(options: CreateMailSenderOptions): {
  readonly sender: MailSender;
  readonly kind: MailSenderKind;
} {
  assertFromAddress(options.from);

  const { smtp } = options;
  const hasSmtpHost =
    smtp !== undefined &&
    typeof smtp.host === 'string' &&
    smtp.host.trim().length > 0;

  if (hasSmtpHost) {
    return {
      sender: createSmtpSender({
        smtp,
        from: options.from,
        ...(options.createTransport !== undefined
          ? { createTransport: options.createTransport }
          : {}),
      }),
      kind: 'smtp',
    };
  }

  return {
    sender: createConsoleSender({
      from: options.from,
      ...(options.nodeEnv !== undefined ? { nodeEnv: options.nodeEnv } : {}),
      ...(options.write !== undefined ? { write: options.write } : {}),
    }),
    kind: 'console',
  };
}
