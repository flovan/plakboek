/**
 * What the client gives the login card to make it work. The server renders
 * the same components with none of this, so every step is static markup there
 * and the behaviour arrives through React context when the client hydrates.
 * Nothing here imports a browser API or the auth library: the pieces are
 * handed in as plain functions, which keeps the steps renderable on the
 * server and testable without a browser.
 */
import { createContext, useContext } from 'react';

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
  | { readonly status: 'failed' };

/** The calls the card makes of the auth service. */
export type LoginAuth = {
  signInEmail(email: string, password: string): Promise<SignInResult>;
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
