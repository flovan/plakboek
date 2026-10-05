/**
 * A mail sender constructed on first send. Stub: the real implementation
 * lands with the GREEN commit.
 */
import type {
  CreateMailSenderOptions,
  MailMessage,
  MailSender,
  MailSenderKind,
} from '@plakboek/auth';
import type { RuntimeEnv } from './env.js';

export class MailNotConfiguredError extends Error {
  readonly reason: 'smtp' | 'from' = 'smtp';
}

export type LazyMailSender = MailSender & {
  describe(): 'smtp' | 'console' | 'unconfigured';
};

export type CreateLazyMailSenderOptions = {
  readonly env: Pick<RuntimeEnv, 'smtp' | 'mailFrom' | 'production'>;
  readonly create?: (options: CreateMailSenderOptions) => {
    readonly sender: MailSender;
    readonly kind: MailSenderKind;
  };
};

export function createLazyMailSender(
  _options: CreateLazyMailSenderOptions,
): LazyMailSender {
  return {
    send(_message: MailMessage): Promise<void> {
      return Promise.reject(new Error('not implemented'));
    },
    describe: () => 'unconfigured',
  };
}
