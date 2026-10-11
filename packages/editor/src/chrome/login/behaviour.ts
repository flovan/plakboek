/**
 * What the client gives the login card to make it work. The server renders
 * the same components with none of this, so every step is static markup there
 * and the behaviour arrives through React context when the client hydrates.
 * Nothing here imports a browser API or the auth library: the pieces are
 * handed in as plain functions, which keeps the steps renderable on the
 * server and testable without a browser.
 */
import { createContext, useContext } from 'react';
import type { AuthFailure } from '../../client/login/validation.js';

/** A signed-in user, as far as the card needs to know. */
export type SignedInUser = {
  readonly name: string;
  readonly email: string;
  /** The user's role key, or `null` when the answer carried none. */
  readonly role: string | null;
  readonly twoFactorEnabled: boolean;
};

/** What a password sign-in came to. */
export type SignInResult =
  | { readonly status: 'signed-in'; readonly user: SignedInUser }
  /** The password was right and a second factor is needed. */
  | { readonly status: 'two-factor' }
  | { readonly status: 'failed'; readonly failure: AuthFailure };

/** What checking a second-factor code came to. */
export type CodeResult =
  | { readonly status: 'verified'; readonly user: SignedInUser }
  | { readonly status: 'failed'; readonly failure: AuthFailure };

/** What asking for an emailed code came to. */
export type SendResult =
  | { readonly status: 'sent' }
  | { readonly status: 'failed'; readonly failure: AuthFailure };

/** What asking for a new authenticator key came to. */
export type EnableResult =
  | {
      readonly status: 'enabled';
      /** The `otpauth://` link that carries the key. */
      readonly setupUri: string;
      /** The one-time backup codes, shown once and never kept. */
      readonly backupCodes: readonly string[];
    }
  | { readonly status: 'failed'; readonly failure: AuthFailure };

/** What asking for an emailed link came to. The service answers the same
 * for every well-formed address, so there is no variant for an unknown one. */
export type LinkRequestResult =
  | { readonly status: 'sent' }
  | { readonly status: 'failed'; readonly failure: AuthFailure };

/** The two links that choose a password: an invitation and a reset. */
export type PasswordLinkPurpose = 'set-password' | 'reset-password';

/** What spending a set-password or reset-password link came to. */
export type CompleteLinkResult =
  | { readonly status: 'done' }
  /** Expired, already used, or never issued: the service does not say which. */
  | { readonly status: 'invalid-link' }
  /** The new password is below the minimum; the link was not spent. */
  | { readonly status: 'too-short' }
  | { readonly status: 'failed'; readonly failure: AuthFailure };

/** Whether the browser holds a session, read after a sign-in link landed. */
export type SessionResult =
  | { readonly status: 'signed-in'; readonly user: SignedInUser }
  | { readonly status: 'none' }
  | { readonly status: 'failed'; readonly failure: AuthFailure };

/** The calls the card makes of the auth service. */
export type LoginAuth = {
  signInEmail(email: string, password: string): Promise<SignInResult>;
  /** Checks the code of the authenticator app against the pending sign-in. */
  verifyTotp(code: string): Promise<CodeResult>;
  /** Mails a code to the user whose password step just succeeded. */
  sendOtp(): Promise<SendResult>;
  /** Checks the emailed code against the pending sign-in. */
  verifyOtp(code: string): Promise<CodeResult>;
  /**
   * Asks for a new authenticator key for the signed-in user, confirming the
   * password first. The key is not active until `verifyTotp` accepts a code
   * from it, which is also how the sign-in being set up is completed.
   */
  enableTwoFactor(password: string): Promise<EnableResult>;
  /** Asks for a password-reset link to be emailed; `next` rides on the link. */
  requestResetLink(email: string, next: string): Promise<LinkRequestResult>;
  /** Asks for a sign-in link to be emailed; `next` rides on the link. */
  requestSignInLink(email: string, next: string): Promise<LinkRequestResult>;
  /** Spends an emailed link's token to set the account's password. */
  completePasswordLink(
    purpose: PasswordLinkPurpose,
    token: string,
    newPassword: string,
  ): Promise<CompleteLinkResult>;
  /** The session the browser now holds, if any. */
  readSession(): Promise<SessionResult>;
};

export type LoginBehaviour = {
  readonly auth: LoginAuth;
  /**
   * Called with the card's dialog each time one is mounted: makes it a modal.
   * It must keep one identity for the life of the root, or React would call
   * it again on every render.
   */
  readonly dialogRef: (dialog: HTMLDialogElement | null) => void;
  /** A sign-in finished: leave the card for edit mode (or for set-up). */
  readonly signedIn: (user: SignedInUser) => void;
};

/** `null` on the server and before the client has hydrated. */
export const LoginBehaviourContext = createContext<LoginBehaviour | null>(null);

export function useLoginBehaviour(): LoginBehaviour | null {
  return useContext(LoginBehaviourContext);
}

/**
 * True once the card has moved on from the step the page opened on. The first
 * step focuses its own first field; every later step focuses its heading, so
 * the change is announced and Tab reaches the first field next.
 */
export const StepFocusContext = createContext(false);
