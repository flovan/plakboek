/**
 * The browser's side of signing in: the auth library's client, imported only
 * when the first request needs it so the shell's own chunk never carries it,
 * and a thin layer over it that answers in the card's terms.
 *
 * Every call is same-origin, to `/api/auth`, and the server checks the
 * request's origin and the session cookie itself. Nothing here decides
 * whether a person may do anything.
 */
import type {
  CodeResult,
  EnableResult,
  LoginAuth,
  SendResult,
  SignedInUser,
  SignInResult,
} from '../../chrome/login/behaviour.js';
import { classifyAuthError, type AuthFailure } from './validation.js';

/** What a call to the auth service answers: the data, or the error it was
 * refused with (`status` is the HTTP status, `code` the library's own code). */
export type AuthCallResult = {
  readonly data: unknown;
  readonly error: {
    readonly status?: number;
    readonly code?: string;
    readonly message?: string;
  } | null;
};

/** The calls the card makes of the auth client, spelled out here so the
 * library's own (very large) inferred type never leaks into this package's
 * declarations. The real client must satisfy it, and the compiler checks so. */
export type AuthClient = {
  readonly signIn: {
    email(input: {
      readonly email: string;
      readonly password: string;
    }): Promise<AuthCallResult>;
  };
  readonly twoFactor: {
    verifyTotp(input: { readonly code: string }): Promise<AuthCallResult>;
    verifyOtp(input: { readonly code: string }): Promise<AuthCallResult>;
    sendOtp(): Promise<AuthCallResult>;
    enable(input: { readonly password: string }): Promise<AuthCallResult>;
  };
};

async function createClient(): Promise<AuthClient> {
  // Dynamic imports: the library is a separate chunk, loaded on first use.
  const { createAuthClient } = await import('better-auth/client');
  const { twoFactorClient, magicLinkClient } =
    await import('better-auth/client/plugins');
  return createAuthClient({
    baseURL: globalThis.location.origin,
    basePath: '/api/auth',
    plugins: [twoFactorClient(), magicLinkClient()],
  });
}

let pending: Promise<AuthClient> | null = null;

/**
 * The one auth client of this page, created on the first call. A failed
 * import (the network dropped) is not remembered, so the next call tries
 * again.
 */
export function getAuthClient(): Promise<AuthClient> {
  pending ??= createClient().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The user an auth answer carries, reduced to what the card reads. The
 * `role` and `twoFactorEnabled` fields are the server's own columns; they are
 * read here only to choose between the card's next steps, and the server
 * re-checks everything that matters on the next request. */
export function readSignedInUser(value: unknown): SignedInUser | null {
  if (!isRecord(value)) return null;
  const email = typeof value.email === 'string' ? value.email : null;
  if (email === null) return null;
  return {
    name: typeof value.name === 'string' ? value.name : '',
    email,
    role: typeof value.role === 'string' ? value.role : null,
    twoFactorEnabled: value.twoFactorEnabled === true,
  };
}

/** The card's auth calls over the real client. */
export function createLoginAuth(
  client: () => Promise<AuthClient> = getAuthClient,
): LoginAuth {
  /** A refused call or a thrown one, as the failure the card shows. */
  async function call(
    run: (client: AuthClient) => Promise<AuthCallResult>,
  ): Promise<
    | { readonly ok: true; readonly data: unknown }
    | { readonly ok: false; readonly failure: AuthFailure }
  > {
    try {
      const result = await run(await client());
      if (result.error !== null) {
        return { ok: false, failure: classifyAuthError(result.error) };
      }
      return { ok: true, data: result.data };
    } catch (error) {
      return { ok: false, failure: classifyAuthError(error) };
    }
  }

  async function verify(
    run: (client: AuthClient) => Promise<AuthCallResult>,
  ): Promise<CodeResult> {
    const result = await call(run);
    if (!result.ok) return { status: 'failed', failure: result.failure };
    const user = readSignedInUser(
      isRecord(result.data) ? result.data.user : null,
    );
    // An answer without a user is not a sign-in, whatever its status.
    return user === null
      ? { status: 'failed', failure: 'server' }
      : { status: 'verified', user };
  }

  return {
    async signInEmail(email, password): Promise<SignInResult> {
      const result = await call((auth) =>
        auth.signIn.email({ email, password }),
      );
      if (!result.ok) return { status: 'failed', failure: result.failure };
      const { data } = result;
      if (isRecord(data) && data.twoFactorRedirect === true) {
        return { status: 'two-factor' };
      }
      const user = readSignedInUser(isRecord(data) ? data.user : null);
      return user === null
        ? { status: 'failed', failure: 'server' }
        : { status: 'signed-in', user };
    },
    verifyTotp: (code) => verify((auth) => auth.twoFactor.verifyTotp({ code })),
    verifyOtp: (code) => verify((auth) => auth.twoFactor.verifyOtp({ code })),
    async enableTwoFactor(password): Promise<EnableResult> {
      const result = await call((auth) => auth.twoFactor.enable({ password }));
      if (!result.ok) return { status: 'failed', failure: result.failure };
      const { data } = result;
      const setupUri =
        isRecord(data) && typeof data.totpURI === 'string' ? data.totpURI : '';
      const backupCodes =
        isRecord(data) && Array.isArray(data.backupCodes)
          ? data.backupCodes.filter(
              (code): code is string => typeof code === 'string',
            )
          : [];
      // An answer with no key is not one the card can show.
      return setupUri === ''
        ? { status: 'failed', failure: 'server' }
        : { status: 'enabled', setupUri, backupCodes };
    },
    async sendOtp(): Promise<SendResult> {
      const result = await call((auth) => auth.twoFactor.sendOtp());
      return result.ok
        ? { status: 'sent' }
        : { status: 'failed', failure: result.failure };
    },
  };
}
