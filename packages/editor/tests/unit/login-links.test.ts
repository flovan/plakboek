/**
 * The card's emailed-link calls, over a stand-in for the auth client: what
 * each is sent, and which answer of the service means what to the card.
 */
import { PASSWORD_MIN_LENGTH } from '@plakboek/auth';
import { describe, expect, it } from 'vitest';
import {
  createLoginAuth,
  magicLinkCallbacks,
  type AuthCallResult,
  type AuthClient,
} from '../../src/client/login/auth-client.js';
import {
  PASSWORD_MIN_LENGTH as CLIENT_PASSWORD_MIN_LENGTH,
  validateNewPassword,
  validatePasswordConfirmation,
} from '../../src/client/login/validation.js';

const OK: AuthCallResult = { data: { status: true }, error: null };

function refused(status: number, code?: string): AuthCallResult {
  return {
    data: null,
    error: { status, ...(code === undefined ? {} : { code }) },
  };
}

type Calls = {
  fetch: { path: string; body: unknown }[];
  magic: unknown[];
  backup: unknown[];
};

/** A client whose answers are set per test; every call is recorded. */
function fakeClient(answers: {
  readonly fetch?: AuthCallResult;
  readonly magic?: AuthCallResult;
  readonly session?: AuthCallResult;
  readonly backup?: AuthCallResult;
}): { readonly client: () => Promise<AuthClient>; readonly calls: Calls } {
  const calls: Calls = { fetch: [], magic: [], backup: [] };
  const never = (): Promise<AuthCallResult> =>
    Promise.reject(new Error('not used here'));
  const client: AuthClient = {
    signIn: {
      email: never,
      magicLink: (input) => {
        calls.magic.push(input);
        return Promise.resolve(answers.magic ?? OK);
      },
    },
    twoFactor: {
      verifyTotp: never,
      verifyOtp: never,
      verifyBackupCode: (input) => {
        calls.backup.push(input);
        return Promise.resolve(answers.backup ?? OK);
      },
      sendOtp: never,
      enable: never,
    },
    getSession: () =>
      Promise.resolve(answers.session ?? { data: null, error: null }),
    $fetch: (path, options) => {
      calls.fetch.push({ path, body: options.body });
      return Promise.resolve(answers.fetch ?? OK);
    },
  };
  return { client: () => Promise.resolve(client), calls };
}

describe('the new-password checks', () => {
  it('holds the minimum equal to the auth package floor', () => {
    expect(CLIENT_PASSWORD_MIN_LENGTH).toBe(PASSWORD_MIN_LENGTH);
  });

  it('counts characters, not code units', () => {
    expect(validateNewPassword('a'.repeat(11))).toBe(
      'Use at least 12 characters.',
    );
    expect(validateNewPassword('a'.repeat(12))).toBeNull();
    expect(validateNewPassword('\u{1F600}'.repeat(12))).toBeNull();
    expect(validateNewPassword('\u{1F600}'.repeat(11))).not.toBeNull();
  });

  it('asks for the two passwords to match exactly', () => {
    expect(validatePasswordConfirmation('abc', 'abc')).toBeNull();
    expect(validatePasswordConfirmation('abc', 'abd')).toBe(
      'The two passwords do not match.',
    );
    expect(validatePasswordConfirmation('abc', 'abc ')).not.toBeNull();
  });
});

describe('magicLinkCallbacks', () => {
  it('points at the fixed landing and carries the page to return to', () => {
    expect(magicLinkCallbacks('/about?x=1&y=2')).toEqual({
      callbackURL: '/cms/magic-link?next=%2Fabout%3Fx%3D1%26y%3D2',
      errorCallbackURL: '/cms/magic-link?error=1&next=%2Fabout%3Fx%3D1%26y%3D2',
    });
  });
});

describe('requestResetLink and requestSignInLink', () => {
  it('post the address and the page to return to', async () => {
    const { client, calls } = fakeClient({});
    const auth = createLoginAuth(client);
    expect(await auth.requestResetLink('a@b.test', '/about')).toEqual({
      status: 'sent',
    });
    expect(await auth.requestSignInLink('a@b.test', '/about')).toEqual({
      status: 'sent',
    });
    expect(calls.fetch).toEqual([
      {
        path: '/plakboek/password-link/request',
        body: { email: 'a@b.test', next: '/about' },
      },
    ]);
    expect(calls.magic).toEqual([
      {
        email: 'a@b.test',
        callbackURL: '/cms/magic-link?next=%2Fabout',
        errorCallbackURL: '/cms/magic-link?error=1&next=%2Fabout',
      },
    ]);
  });

  it('read a 429 as rate limiting and anything else as the server', async () => {
    const limited = createLoginAuth(
      fakeClient({ fetch: refused(429), magic: refused(429) }).client,
    );
    expect(await limited.requestResetLink('a@b.test', '/')).toEqual({
      status: 'failed',
      failure: 'rate-limited',
    });
    expect(await limited.requestSignInLink('a@b.test', '/')).toEqual({
      status: 'failed',
      failure: 'rate-limited',
    });
    const broken = createLoginAuth(
      fakeClient({ fetch: refused(500), magic: refused(500) }).client,
    );
    expect(await broken.requestResetLink('a@b.test', '/')).toEqual({
      status: 'failed',
      failure: 'server',
    });
  });

  it('read a call that never got an answer as a network failure', async () => {
    const auth = createLoginAuth(() =>
      Promise.reject(new TypeError('offline')),
    );
    expect(await auth.requestResetLink('a@b.test', '/')).toEqual({
      status: 'failed',
      failure: 'network',
    });
  });
});

describe('completePasswordLink', () => {
  it('posts the purpose, token and password and reports success', async () => {
    const { client, calls } = fakeClient({});
    const auth = createLoginAuth(client);
    expect(
      await auth.completePasswordLink(
        'reset-password',
        'tok',
        'a long enough one',
      ),
    ).toEqual({ status: 'done' });
    expect(calls.fetch).toEqual([
      {
        path: '/plakboek/password-link/complete',
        body: {
          purpose: 'reset-password',
          token: 'tok',
          newPassword: 'a long enough one',
        },
      },
    ]);
  });

  it('tells an unusable link from a too-short password and from a failure', async () => {
    const run = async (answer: AuthCallResult) =>
      await createLoginAuth(
        fakeClient({ fetch: answer }).client,
      ).completePasswordLink('set-password', 'tok', 'x');
    expect(await run(refused(400, 'INVALID_LINK'))).toEqual({
      status: 'invalid-link',
    });
    expect(await run(refused(400, 'PASSWORD_TOO_SHORT'))).toEqual({
      status: 'too-short',
    });
    expect(await run(refused(429))).toEqual({
      status: 'failed',
      failure: 'rate-limited',
    });
    expect(await run(refused(500))).toEqual({
      status: 'failed',
      failure: 'server',
    });
  });
});

describe('readSession', () => {
  it('reads the signed-in user', async () => {
    const auth = createLoginAuth(
      fakeClient({
        session: {
          data: {
            user: {
              name: 'Ada',
              email: 'a@b.test',
              role: 'editor',
              twoFactorEnabled: false,
            },
            session: {},
          },
          error: null,
        },
      }).client,
    );
    expect(await auth.readSession()).toEqual({
      status: 'signed-in',
      user: {
        name: 'Ada',
        email: 'a@b.test',
        role: 'editor',
        twoFactorEnabled: false,
      },
    });
  });

  it('says there is none when the browser holds no session', async () => {
    const auth = createLoginAuth(fakeClient({}).client);
    expect(await auth.readSession()).toEqual({ status: 'none' });
  });

  it('reports a call that failed', async () => {
    const auth = createLoginAuth(fakeClient({ session: refused(500) }).client);
    expect(await auth.readSession()).toEqual({
      status: 'failed',
      failure: 'server',
    });
  });
});

describe('verifyBackupCode', () => {
  it('sends the code and reports the user it signed in', async () => {
    const { client, calls } = fakeClient({
      backup: {
        data: { user: { name: 'Ada', email: 'ada@example.com' } },
        error: null,
      },
    });
    const result =
      await createLoginAuth(client).verifyBackupCode('abcde-12345');
    expect(calls.backup).toEqual([{ code: 'abcde-12345' }]);
    expect(result).toEqual({
      status: 'verified',
      user: {
        name: 'Ada',
        email: 'ada@example.com',
        role: null,
        twoFactorEnabled: false,
      },
    });
  });

  it('reports a refused code as a wrong code, not a credentials failure', async () => {
    const { client } = fakeClient({
      backup: {
        data: null,
        error: { status: 401, code: 'INVALID_BACKUP_CODE' },
      },
    });
    expect(await createLoginAuth(client).verifyBackupCode('nope')).toEqual({
      status: 'failed',
      failure: 'code',
    });
  });
});
