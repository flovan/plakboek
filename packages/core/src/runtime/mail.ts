/**
 * Mail, constructed on first send (F4). Booting the runtime and answering
 * `/cms/health` never touch it, so a production installation without SMTP
 * still starts and serves pages; only an attempt to send mail fails, with a
 * clear error, instead of crashing the process at boot.
 */
import {
  createMailSender,
  type CreateMailSenderOptions,
  type MailMessage,
  type MailSender,
  type MailSenderKind,
} from '@plakboek/auth';
import type { RuntimeEnv } from './env.js';

/** Mail cannot be sent because configuration is missing. */
export class MailNotConfiguredError extends Error {
  readonly reason: 'smtp' | 'from';

  constructor(reason: 'smtp' | 'from') {
    super(
      reason === 'smtp'
        ? 'No SMTP server is configured. Set the PLAKBOEK_SMTP_* variables.'
        : 'No sender address is configured. Set PLAKBOEK_MAIL_FROM.',
    );
    this.name = 'MailNotConfiguredError';
    this.reason = reason;
  }
}

export type LazyMailSender = MailSender & {
  /** What a send would use, without constructing anything. */
  describe(): 'smtp' | 'console' | 'unconfigured';
};

export type CreateLazyMailSenderOptions = {
  readonly env: Pick<RuntimeEnv, 'smtp' | 'mailFrom' | 'production'>;
  /** Defaults to `createMailSender`; tests inject a fake. */
  readonly create?: (options: CreateMailSenderOptions) => {
    readonly sender: MailSender;
    readonly kind: MailSenderKind;
  };
};

export function createLazyMailSender(
  options: CreateLazyMailSenderOptions,
): LazyMailSender {
  const { env } = options;
  const create = options.create ?? createMailSender;
  let sender: MailSender | undefined;

  function resolve(): MailSender {
    if (sender !== undefined) return sender;
    if (env.smtp === undefined && env.production) {
      throw new MailNotConfiguredError('smtp');
    }
    if (env.mailFrom === undefined) {
      throw new MailNotConfiguredError('from');
    }
    // A failed construction is not remembered, so fixing the environment and
    // retrying does not need a restart of the sender.
    const created = create({
      ...(env.smtp === undefined ? {} : { smtp: env.smtp }),
      from: env.mailFrom,
      nodeEnv: env.production ? 'production' : 'development',
    });
    sender = created.sender;
    return sender;
  }

  return {
    async send(message: MailMessage): Promise<void> {
      await resolve().send(message);
    },
    describe() {
      if (env.smtp !== undefined) return 'smtp';
      return env.production ? 'unconfigured' : 'console';
    },
  };
}
