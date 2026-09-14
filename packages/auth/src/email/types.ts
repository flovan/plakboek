/**
 * The mail contract every mail-sending flow in @plakboek/auth consumes
 * (invites, password resets, magic links, 2FA codes). It is deliberately
 * transport-agnostic: `createAuth` receives a `MailSender` and never learns
 * how a message leaves the process. The SMTP transport and the development
 * console sender are separate implementations of this same contract.
 */

/** One fully rendered transactional message. Both bodies are required so
 * every message has a plain-text alternative. */
export type MailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

/** Delivers one message. Resolves once the transport has accepted it and
 * rejects with `MailSendError` when it could not. */
export type MailSender = {
  send(message: MailMessage): Promise<void>;
};

/** Returns the part after the last `@`, or `'unknown'` when there is none,
 * so a malformed address still yields a message without echoing it. */
function recipientDomainOf(address: string): string {
  const at = typeof address === 'string' ? address.lastIndexOf('@') : -1;
  const domain = at === -1 ? '' : address.slice(at + 1).trim();
  return domain.length > 0 ? domain : 'unknown';
}

/**
 * Thrown by a `MailSender` when a message could not be delivered. The
 * message names the recipient's domain only -- never the full address, the
 * subject, or any URL or token the body carried -- so it is safe to log.
 * The underlying transport error, if any, travels as `cause`.
 */
export class MailSendError extends Error {
  readonly recipientDomain: string;

  constructor(recipient: string, options?: { readonly cause?: unknown }) {
    const recipientDomain = recipientDomainOf(recipient);
    super(
      `@plakboek/auth: could not deliver mail to a recipient at ${recipientDomain}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'MailSendError';
    this.recipientDomain = recipientDomain;
  }
}
