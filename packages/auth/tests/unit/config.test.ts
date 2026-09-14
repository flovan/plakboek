import { defaultRoles, defineRoles } from '@plakboek/permissions';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthConfigError,
  DISABLED_AUTH_PATHS,
  IMPERSONATION_SESSION_TTL_SECONDS,
  MAGIC_LINK_TTL_SECONDS,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  SET_PASSWORD_TOKEN_TTL_SECONDS,
  TWO_FACTOR_CODE_TTL_SECONDS,
  TWO_FACTOR_LOCKOUT,
  createAuth,
  type CreateAuthOptions,
} from '../../src/config.js';
import {
  MailSendError,
  type MailMessage,
  type MailSender,
} from '../../src/email/types.js';

const SECRET = 'unit-test-secret-with-at-least-32-characters';

const noopSender: MailSender = { send: () => Promise.resolve() };

/** A drizzle handle that never opens a connection. */
function baseOptions(
  overrides: Partial<CreateAuthOptions> = {},
): CreateAuthOptions {
  return {
    db: drizzle.mock(),
    baseURL: 'http://localhost:3000',
    secret: SECRET,
    mail: noopSender,
    roles: defineRoles(defaultRoles),
    ...overrides,
  };
}

/** Calls createAuth with options outside its declared types, the way a
 * plain-JS host could, and returns what it threw. */
function captureError(options: Record<string, unknown>): unknown {
  try {
    Reflect.apply(createAuth, undefined, [options]);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Lets every detached promise chain settle. */
async function flushDetached(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

type SendMagicLink = (
  data: { email: string; url: string; token: string },
  ctx: unknown,
) => Promise<void>;

type SendOtp = (data: {
  user: { id: string; email: string; name: string };
  otp: string;
}) => Promise<void>;

function pluginOption(
  auth: ReturnType<typeof createAuth>,
  pluginId: string,
): unknown {
  const plugin = auth.options.plugins.find(
    (candidate) => candidate.id === pluginId,
  );
  return Reflect.get(plugin ?? {}, 'options');
}

function magicLinkSender(auth: ReturnType<typeof createAuth>) {
  const send: unknown = Reflect.get(
    pluginOption(auth, 'magic-link') ?? {},
    'sendMagicLink',
  );
  expect(send).toBeTypeOf('function');
  return send as SendMagicLink;
}

function otpSender(auth: ReturnType<typeof createAuth>) {
  const otpOptions: unknown = Reflect.get(
    pluginOption(auth, 'two-factor') ?? {},
    'otpOptions',
  );
  const send: unknown = Reflect.get(otpOptions ?? {}, 'sendOTP');
  expect(send).toBeTypeOf('function');
  return send as SendOtp;
}

/** The slice of better-auth's endpoint context sendMagicLink reads. */
function lookupContext(registered: ReadonlySet<string>) {
  return {
    context: {
      internalAdapter: {
        findUserByEmail: (email: string) =>
          Promise.resolve(
            registered.has(email)
              ? { user: { id: 'u1', email, name: 'Ada' }, accounts: [] }
              : null,
          ),
      },
    },
  };
}

const USER = { id: 'u1', email: 'ada@example.com', name: 'Ada' };

describe('createAuth option validation', () => {
  it('rejects a 31-character secret without echoing it', () => {
    const secret = 'x'.repeat(31);
    const error = captureError({ ...baseOptions(), secret });
    expect(error).toBeInstanceOf(AuthConfigError);
    expect(String(error)).not.toContain(secret);
    expect((error as Error).message).toContain('secret');
  });

  it('rejects a baseURL that is not a URL', () => {
    const error = captureError({ ...baseOptions(), baseURL: 'not a url' });
    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('baseURL');
  });

  it('rejects a mail object without a send function', () => {
    const error = captureError({ ...baseOptions(), mail: {} });
    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('mail');
  });

  it('rejects a renderEmail that is not a function', () => {
    const error = captureError({ ...baseOptions(), renderEmail: 'template' });
    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('renderEmail');
  });

  it('rejects a minPasswordLength below the policy floor', () => {
    const error = captureError({ ...baseOptions(), minPasswordLength: 8 });
    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('minPasswordLength');
  });

  it('accepts a minPasswordLength above the policy floor', () => {
    const auth = createAuth(baseOptions({ minPasswordLength: 16 }));
    expect(auth.options.emailAndPassword?.minPasswordLength).toBe(16);
  });

  it('rejects an onMailDeliveryError that is not a function', () => {
    const error = captureError({
      ...baseOptions(),
      onMailDeliveryError: 'log',
    });
    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('onMailDeliveryError');
  });
});

describe('policy constants', () => {
  it('holds the locked session, token, magic-link and lockout values', () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(2_592_000);
    expect(IMPERSONATION_SESSION_TTL_SECONDS).toBe(28_800);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(86_400);
    expect(SET_PASSWORD_TOKEN_TTL_SECONDS).toBe(172_800);
    expect(MAGIC_LINK_TTL_SECONDS).toBe(900);
    expect(TWO_FACTOR_CODE_TTL_SECONDS).toBe(300);
    expect(TWO_FACTOR_LOCKOUT).toEqual({
      maxFailedAttempts: 5,
      durationSeconds: 900,
    });
    expect(Object.isFrozen(TWO_FACTOR_LOCKOUT)).toBe(true);
  });

  it('passes the constants to better-auth rather than restating them', () => {
    const auth = createAuth(baseOptions());
    expect(auth.options.session).toMatchObject({
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    });
    expect(pluginOption(auth, 'magic-link')).toMatchObject({
      expiresIn: MAGIC_LINK_TTL_SECONDS,
      disableSignUp: true,
      storeToken: 'hashed',
    });
    expect(pluginOption(auth, 'two-factor')).toMatchObject({
      otpOptions: { storeOTP: 'hashed' },
      accountLockout: { enabled: true, ...TWO_FACTOR_LOCKOUT },
    });
    expect(pluginOption(auth, 'admin')).toMatchObject({
      impersonationSessionDuration: IMPERSONATION_SESSION_TTL_SECONDS,
    });
  });
});

describe('closed better-auth HTTP routes', () => {
  it('lists sign-up, direct impersonation and every built-in reset route', () => {
    expect([...DISABLED_AUTH_PATHS].toSorted()).toEqual([
      '/admin/impersonate-user',
      '/admin/stop-impersonating',
      '/request-password-reset',
      '/reset-password',
      '/reset-password/:token',
      '/sign-up/email',
    ]);
    expect(Object.isFrozen(DISABLED_AUTH_PATHS)).toBe(true);
  });

  it('hands the list to better-auth as disabledPaths', () => {
    const auth = createAuth(baseOptions());
    expect(auth.options.disabledPaths).toEqual([...DISABLED_AUTH_PATHS]);
  });

  it('leaves email-and-password sign-in on, with no built-in reset behind the closed routes', () => {
    const auth = createAuth(baseOptions());
    const emailAndPassword = auth.options.emailAndPassword;
    expect(emailAndPassword?.enabled).toBe(true);
    expect(emailAndPassword).not.toHaveProperty('sendResetPassword');
    expect(emailAndPassword).not.toHaveProperty('resetPasswordTokenExpiresIn');
    expect(emailAndPassword).not.toHaveProperty(
      'revokeSessionsOnPasswordReset',
    );
  });
});

describe('unauthenticated mail paths (D-15)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
    vi.restoreAllMocks();
  });

  it('keeps a throwing hook from escaping and falls back to the default line', async () => {
    process.on('unhandledRejection', onUnhandled);
    const logged = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const auth = createAuth(
      baseOptions({
        mail: {
          send: () => Promise.reject(new MailSendError(USER.email)),
        },
        onMailDeliveryError: () => {
          throw new Error('hook failed');
        },
      }),
    );

    await magicLinkSender(auth)(
      {
        email: USER.email,
        url: 'http://localhost:3000/api/auth/magic-link/verify?token=t',
        token: 't',
      },
      lookupContext(new Set([USER.email])),
    );
    await flushDetached();

    expect(unhandled).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('MailSendError');
    expect(line).toContain('example.com');
    expect(line).not.toContain('ada@');
  });

  it('sends a magic link only to a registered address, without awaiting the send', async () => {
    const sent: MailMessage[] = [];
    const auth = createAuth(
      baseOptions({
        mail: {
          send: (message) => {
            sent.push(message);
            return new Promise<void>(() => undefined);
          },
        },
      }),
    );
    const send = magicLinkSender(auth);
    const context = lookupContext(new Set([USER.email]));
    const url = 'http://localhost:3000/api/auth/magic-link/verify?token=t';

    await send({ email: 'nobody@example.com', url, token: 't' }, context);
    expect(sent).toEqual([]);

    await send({ email: USER.email, url, token: 't' }, context);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(USER.email);
    expect(sent[0]?.text).toContain('15 minutes');
  });

  it('reports a rejected magic-link send exactly once', async () => {
    process.on('unhandledRejection', onUnhandled);
    const onMailDeliveryError = vi.fn<(error: unknown) => void>();
    const auth = createAuth(
      baseOptions({
        mail: { send: () => Promise.reject(new MailSendError(USER.email)) },
        onMailDeliveryError,
      }),
    );

    await magicLinkSender(auth)(
      {
        email: USER.email,
        url: 'http://localhost:3000/api/auth/magic-link/verify?token=t',
        token: 't',
      },
      lookupContext(new Set([USER.email])),
    );
    await flushDetached();

    expect(onMailDeliveryError).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it('awaits the emailed second-factor code, which runs after the password step', async () => {
    const order: string[] = [];
    const auth = createAuth(
      baseOptions({
        mail: {
          send: async (message) => {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            order.push(`sent:${message.subject}`);
          },
        },
      }),
    );

    await otpSender(auth)({ user: USER, otp: '123456' });
    order.push('returned');

    expect(order).toEqual(['sent:Your verification code', 'returned']);
  });
});
