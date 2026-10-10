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
  LoginAuth,
  SignedInUser,
  SignInResult,
} from '../../chrome/login/behaviour.js';

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
  return {
    async signInEmail(email, password): Promise<SignInResult> {
      try {
        const result = await (await client()).signIn.email({ email, password });
        if (result.error !== null) return { status: 'failed' };
        const data: unknown = result.data;
        if (isRecord(data) && data.twoFactorRedirect === true) {
          return { status: 'two-factor' };
        }
        const user = readSignedInUser(isRecord(data) ? data.user : null);
        return user === null
          ? { status: 'failed' }
          : { status: 'signed-in', user };
      } catch {
        return { status: 'failed' };
      }
    },
  };
}
