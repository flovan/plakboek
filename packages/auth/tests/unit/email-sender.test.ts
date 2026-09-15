import { describe, expect, it } from 'vitest';
import {
  MailSenderConfigError,
  createConsoleSender,
  createMailSender,
  createSmtpSender,
  type SmtpTransport,
  type SmtpTransportConfig,
  type SmtpTransportMessage,
} from '../../src/email/sender.js';
import { MailSendError, type MailMessage } from '../../src/email/types.js';

/** Stands in for nodemailer's `createTransport`. It records the config it
 * was built with and every message handed to it, and never opens a socket.
 * With `reject` set, `sendMail` fails the way an unreachable or refusing
 * server would, echoing everything it was given in its own error. */
function recordingTransport(options?: { readonly reject?: boolean }) {
  const configs: SmtpTransportConfig[] = [];
  const sent: SmtpTransportMessage[] = [];

  function createTransport(config: SmtpTransportConfig): SmtpTransport {
    configs.push(config);
    return {
      async sendMail(message: SmtpTransportMessage): Promise<unknown> {
        sent.push(message);
        if (options?.reject === true) {
          throw new Error(
            `550 rejected ${message.to} ${message.subject} ${message.html} auth=${config.auth?.pass ?? ''}`,
          );
        }
        return { messageId: '<fake@transport>' };
      },
    };
  }

  return { configs, sent, createTransport };
}

/** Calls a factory with arguments that may not match its declared types,
 * the way a plain-JS host would, and returns what it threw. */
function captureError(
  factory: (...args: never[]) => unknown,
  ...args: unknown[]
): unknown {
  try {
    Reflect.apply(factory, undefined, args);
  } catch (error) {
    return error;
  }
  return undefined;
}

const FROM = 'noreply@b.test';

const MESSAGE: MailMessage = {
  to: 'alice.local-part@b.test',
  subject: 'Reset your Plakboek password',
  html: '<p>Open https://cms.b.test/reset?token=tok_7Hq2xZ to continue</p>',
  text: 'Open https://cms.b.test/reset?token=tok_7Hq2xZ to continue',
};

describe('createMailSender', () => {
  it('selects the SMTP sender when an smtp host is supplied', () => {
    const transport = recordingTransport();
    const { sender, kind } = createMailSender({
      smtp: { host: 'smtp.b.test', port: 587, user: 'u', pass: 'p_secret' },
      from: 'a@b.test',
      createTransport: transport.createTransport,
    });

    expect(kind).toBe('smtp');
    expect(typeof sender.send).toBe('function');
    expect(transport.configs).toHaveLength(1);
  });

  it('selects the console sender when smtp is absent outside production', () => {
    const transport = recordingTransport();
    const { sender, kind } = createMailSender({
      smtp: undefined,
      from: 'a@b.test',
      nodeEnv: 'development',
      createTransport: transport.createTransport,
    });

    expect(kind).toBe('console');
    expect(typeof sender.send).toBe('function');
    expect(transport.configs).toHaveLength(0);
  });

  it('treats an empty or whitespace-only host as absent', () => {
    const transport = recordingTransport();
    for (const host of ['', '   ']) {
      const { kind } = createMailSender({
        smtp: { host },
        from: 'a@b.test',
        nodeEnv: 'development',
        createTransport: transport.createTransport,
      });
      expect(kind).toBe('console');
    }
    expect(transport.configs).toHaveLength(0);
  });

  it('refuses to fall back to the console sender in production', () => {
    for (const smtp of [undefined, { host: '' }, { host: '  ' }]) {
      const error = captureError(createMailSender, {
        smtp,
        from: 'a@b.test',
        nodeEnv: 'production',
      });
      expect(error).toBeInstanceOf(MailSenderConfigError);
      expect(String(error)).toMatch(/production/);
    }
  });

  it('rejects an empty from address', () => {
    const transport = recordingTransport();
    const error = captureError(createMailSender, {
      smtp: { host: 'smtp.b.test', port: 587 },
      from: '',
      createTransport: transport.createTransport,
    });
    expect(error).toBeInstanceOf(MailSenderConfigError);
  });

  it('rejects a from value that is not a single address', () => {
    const transport = recordingTransport();
    for (const from of [
      'not-an-address',
      '@b.test',
      'a@',
      'a@b@c.test',
      'noreply@b.test\r\nBcc: victim',
    ]) {
      const error = captureError(createMailSender, {
        smtp: { host: 'smtp.b.test', port: 587 },
        from,
        createTransport: transport.createTransport,
      });
      expect(error).toBeInstanceOf(MailSenderConfigError);
    }
    expect(transport.configs).toHaveLength(0);
  });

  it('rejects a port that is not an integer between 1 and 65535', () => {
    const transport = recordingTransport();
    for (const port of [0, 70_000, 587.5, Number.NaN]) {
      const error = captureError(createMailSender, {
        smtp: { host: 'smtp.b.test', port },
        from: 'a@b.test',
        createTransport: transport.createTransport,
      });
      expect(error).toBeInstanceOf(MailSenderConfigError);
    }
    expect(transport.configs).toHaveLength(0);
  });

  it('rejects half a credential but allows an unauthenticated relay', () => {
    const transport = recordingTransport();
    for (const credential of [{ user: 'u' }, { pass: 'p_secret' }]) {
      const error = captureError(createMailSender, {
        smtp: { host: 'smtp.b.test', port: 587, ...credential },
        from: 'a@b.test',
        createTransport: transport.createTransport,
      });
      expect(error).toBeInstanceOf(MailSenderConfigError);
    }
    expect(transport.configs).toHaveLength(0);

    const { kind } = createMailSender({
      smtp: { host: 'smtp.b.test', port: 587 },
      from: 'a@b.test',
      createTransport: transport.createTransport,
    });
    expect(kind).toBe('smtp');
    expect(transport.configs[0]?.auth).toBeUndefined();
  });

  it('rejects a secure flag that is not a boolean', () => {
    const transport = recordingTransport();
    const error = captureError(createMailSender, {
      smtp: { host: 'smtp.b.test', secure: 'false' },
      from: 'a@b.test',
      createTransport: transport.createTransport,
    });
    expect(error).toBeInstanceOf(MailSenderConfigError);
    expect(transport.configs).toHaveLength(0);
  });

  it('never echoes a credential, host or address in a configuration error', () => {
    const transport = recordingTransport();
    const secrets = [
      'p_secret',
      'smtp-user-9f2c',
      'relay.secret-host.test',
      'sender.local@b.test',
    ];
    const cases = [
      {
        smtp: { host: 'relay.secret-host.test', user: 'smtp-user-9f2c' },
        from: 'sender.local@b.test',
      },
      {
        smtp: { host: 'relay.secret-host.test', pass: 'p_secret', port: 0 },
        from: 'sender.local@b.test',
      },
      {
        smtp: {
          host: 'relay.secret-host.test',
          user: 'smtp-user-9f2c',
          pass: 'p_secret',
        },
        from: 'sender.local@b.test@b.test',
      },
    ];

    for (const options of cases) {
      const error = captureError(createMailSender, {
        ...options,
        createTransport: transport.createTransport,
      });
      expect(error).toBeInstanceOf(MailSenderConfigError);
      expect(String(error)).toMatch(
        /^MailSenderConfigError: @plakboek\/auth: /,
      );
      for (const secret of secrets) {
        expect(String(error)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    }
  });
});

describe('createSmtpSender', () => {
  it('defaults to STARTTLS on port 587 with TLS required', () => {
    const transport = recordingTransport();
    createSmtpSender({
      smtp: { host: 'smtp.b.test' },
      from: FROM,
      createTransport: transport.createTransport,
    });

    expect(transport.configs).toHaveLength(1);
    expect(transport.configs[0]).toMatchObject({
      host: 'smtp.b.test',
      port: 587,
      secure: false,
      requireTLS: true,
    });
  });

  it('defaults to implicit TLS on port 465 when secure is set', () => {
    const transport = recordingTransport();
    createSmtpSender({
      smtp: { host: 'smtp.b.test', secure: true },
      from: FROM,
      createTransport: transport.createTransport,
    });

    expect(transport.configs[0]).toMatchObject({
      host: 'smtp.b.test',
      port: 465,
      secure: true,
    });
  });

  it('keeps an explicit port and still requires STARTTLS on it', () => {
    const transport = recordingTransport();
    createSmtpSender({
      smtp: { host: 'smtp.b.test', port: 2525 },
      from: FROM,
      createTransport: transport.createTransport,
    });

    expect(transport.configs[0]).toMatchObject({
      port: 2525,
      secure: false,
      requireTLS: true,
    });
  });

  it('passes credentials only when both user and pass are present', () => {
    const withAuth = recordingTransport();
    createSmtpSender({
      smtp: { host: 'smtp.b.test', user: 'u', pass: 'p_secret' },
      from: FROM,
      createTransport: withAuth.createTransport,
    });
    expect(withAuth.configs[0]?.auth).toEqual({ user: 'u', pass: 'p_secret' });

    const withoutAuth = recordingTransport();
    createSmtpSender({
      smtp: { host: 'smtp.b.test' },
      from: FROM,
      createTransport: withoutAuth.createTransport,
    });
    expect(withoutAuth.configs[0]).not.toHaveProperty('auth');
  });

  it('always bounds the connection, greeting and socket timeouts', () => {
    for (const secure of [false, true]) {
      const transport = recordingTransport();
      createSmtpSender({
        smtp: { host: 'smtp.b.test', secure },
        from: FROM,
        createTransport: transport.createTransport,
      });
      const config = transport.configs[0];

      for (const timeout of [
        config?.connectionTimeout,
        config?.greetingTimeout,
        config?.socketTimeout,
      ]) {
        expect(Number.isFinite(timeout)).toBe(true);
        expect(timeout).toBeGreaterThan(0);
      }
    }
  });

  it('pools connections and builds the transport once, not per message', async () => {
    const transport = recordingTransport();
    const sender = createSmtpSender({
      smtp: { host: 'smtp.b.test' },
      from: FROM,
      createTransport: transport.createTransport,
    });

    await sender.send(MESSAGE);
    await sender.send(MESSAGE);

    expect(transport.configs).toHaveLength(1);
    expect(transport.configs[0]?.pool).toBe(true);
    expect(transport.sent).toHaveLength(2);
  });

  it('hands from, to, subject, html and text to the transport', async () => {
    const transport = recordingTransport();
    const sender = createSmtpSender({
      smtp: { host: 'smtp.b.test' },
      from: FROM,
      createTransport: transport.createTransport,
    });

    await expect(sender.send(MESSAGE)).resolves.toBeUndefined();
    expect(transport.sent[0]).toEqual({
      from: FROM,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
  });

  it('wraps a delivery failure in MailSendError naming only the recipient domain', async () => {
    const transport = recordingTransport({ reject: true });
    const sender = createSmtpSender({
      smtp: { host: 'smtp.b.test', user: 'u', pass: 'p_secret' },
      from: FROM,
      createTransport: transport.createTransport,
    });

    const error: unknown = await sender.send(MESSAGE).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(MailSendError);
    expect(error).toHaveProperty('recipientDomain', 'b.test');
    expect(error).toHaveProperty('cause');
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('b.test');
    for (const leaked of [
      'alice.local-part',
      MESSAGE.subject,
      'https://cms.b.test/reset',
      'tok_7Hq2xZ',
      '<p>',
      'p_secret',
    ]) {
      expect(message).not.toContain(leaked);
    }
  });
});

describe('createConsoleSender', () => {
  it('writes one entry with the recipient, subject and plain-text body', async () => {
    const lines: string[] = [];
    const sender = createConsoleSender({
      from: FROM,
      nodeEnv: 'development',
      write: (line) => {
        lines.push(line);
      },
    });

    await expect(sender.send(MESSAGE)).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(MESSAGE.to);
    expect(lines[0]).toContain(MESSAGE.subject);
    expect(lines[0]).toContain(MESSAGE.text);
  });

  it('refuses to be constructed in production', () => {
    const error = captureError(createConsoleSender, {
      from: FROM,
      nodeEnv: 'production',
      write: () => undefined,
    });
    expect(error).toBeInstanceOf(MailSenderConfigError);
  });
});
