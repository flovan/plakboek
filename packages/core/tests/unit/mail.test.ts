import type { MailMessage, MailSender, MailSenderKind } from '@plakboek/auth';
import { describe, expect, it, vi } from 'vitest';
import {
  MailNotConfiguredError,
  createLazyMailSender,
} from '../../src/runtime/mail.js';

const message: MailMessage = {
  to: 'a@example.com',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
};

function fakeCreate(kind: MailSenderKind = 'smtp') {
  const send = vi.fn((_message: MailMessage) => Promise.resolve());
  const sender: MailSender = { send };
  const create = vi.fn(() => ({ sender, kind }));
  return { create, send };
}

const smtp = { host: 'smtp.example.com' } as const;

describe('createLazyMailSender', () => {
  it('constructs nothing at creation in production without SMTP and rejects a send', async () => {
    const { create } = fakeCreate();
    const mail = createLazyMailSender({
      env: { production: true, mailFrom: 'noreply@example.com' },
      create,
    });
    expect(create).not.toHaveBeenCalled();
    expect(mail.describe()).toBe('unconfigured');

    const rejection = await mail.send(message).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(MailNotConfiguredError);
    expect((rejection as MailNotConfiguredError).reason).toBe('smtp');
    expect((rejection as MailNotConfiguredError).message).toContain(
      'No SMTP server is configured',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('describes itself as console in development without SMTP', () => {
    const { create } = fakeCreate('console');
    const mail = createLazyMailSender({
      env: { production: false, mailFrom: 'noreply@example.com' },
      create,
    });
    expect(mail.describe()).toBe('console');
    expect(create).not.toHaveBeenCalled();
  });

  it('describes itself as smtp when configured and constructs once across two sends', async () => {
    const { create, send } = fakeCreate();
    const mail = createLazyMailSender({
      env: { production: true, smtp, mailFrom: 'noreply@example.com' },
      create,
    });
    expect(mail.describe()).toBe('smtp');
    expect(create).not.toHaveBeenCalled();

    await mail.send(message);
    await mail.send(message);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        smtp,
        from: 'noreply@example.com',
        nodeEnv: 'production',
      }),
    );
  });

  it('constructs a console sender in development', async () => {
    const { create } = fakeCreate('console');
    const mail = createLazyMailSender({
      env: { production: false, mailFrom: 'noreply@example.com' },
      create,
    });
    await mail.send(message);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ nodeEnv: 'development' }),
    );
  });

  it('rejects a missing PLAKBOEK_MAIL_FROM at send time, not at creation', async () => {
    const { create } = fakeCreate();
    const mail = createLazyMailSender({
      env: { production: false, smtp },
      create,
    });
    const rejection = await mail.send(message).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(MailNotConfiguredError);
    expect((rejection as MailNotConfiguredError).reason).toBe('from');
    expect(create).not.toHaveBeenCalled();
  });

  it('retries construction after a failed one', async () => {
    const { send } = fakeCreate();
    const create = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('bad config');
      })
      .mockImplementation(() => ({ sender: { send }, kind: 'smtp' }));
    const mail = createLazyMailSender({
      env: { production: true, smtp, mailFrom: 'noreply@example.com' },
      create,
    });
    await expect(mail.send(message)).rejects.toThrow('bad config');
    await mail.send(message);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
