import { useEffect, type ReactElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { LOGIN_ROOT_ID, type LoginIsland } from '../../chrome/island.js';
import type { LoginBehaviour } from '../../chrome/login/behaviour.js';
import { LoginApp } from '../../chrome/login/login-app.js';
import { createLoginAuth } from './auth-client.js';
import { editAddress, runLoginTransition } from './transition.js';

/** The modal state of the card's dialog, shared by every dialog the card
 * mounts (each step is a fresh dialog). */
type ModalState = { leaving: boolean };

/**
 * Makes a dialog a modal: everything outside it becomes inert and focus stays
 * inside. The server renders it open and non-modal, so the first paint needs
 * no script; this runs after hydration. `close()` first, because opening a
 * dialog that is already open without being modal throws.
 *
 * There is nothing to dismiss to, so Escape does nothing. The `cancel` event
 * is cancelled, and so is the keydown, because a browser may close a dialog
 * on a second Escape however `cancel` was answered; a dialog that closes
 * anyway is opened again, unless the hand-over to edit mode closed it.
 */
function makeModal(dialog: HTMLDialogElement, state: ModalState): void {
  if (!dialog.matches(':modal')) {
    dialog.close();
    dialog.showModal();
  }
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    if (!state.leaving && dialog.isConnected && !dialog.open) {
      dialog.showModal();
    }
  });
}

function LoginRoot(props: {
  readonly host: HTMLElement;
  readonly island: LoginIsland;
  readonly behaviour: LoginBehaviour;
}): ReactElement {
  const { host, island, behaviour } = props;
  useEffect(() => {
    host.dataset.hydrated = '';
  }, [host]);
  return (
    <LoginApp
      step={island.step}
      next={island.next}
      passwordMinLength={island.passwordMinLength}
      {...(island.linkKind === undefined ? {} : { linkKind: island.linkKind })}
      behaviour={behaviour}
    />
  );
}

/**
 * Hydrates the login card the server rendered inside the host's shadow root.
 * The backdrop iframe is outside that root and is never touched by React, so
 * hydrating cannot reload it. Returns the React root, or `null` when the
 * server's root element is missing.
 */
export function mountLogin(
  host: HTMLElement,
  shadowRoot: ShadowRoot,
  island: LoginIsland,
): Root | null {
  const container = shadowRoot.getElementById(LOGIN_ROOT_ID);
  if (container === null) return null;

  const state: ModalState = { leaving: false };
  const behaviour: LoginBehaviour = {
    auth: createLoginAuth(),
    dialogRef: (dialog) => {
      if (dialog !== null) makeModal(dialog, state);
    },
    // A user whose role must set up two-step sign-in is sent there by the
    // server when the edit page is requested, so the card does not need to
    // know which roles those are.
    signedIn: (user) => {
      void runLoginTransition({
        host,
        shadowRoot,
        next: island.next,
        user,
        reducedMotion: globalThis.matchMedia('(prefers-reduced-motion: reduce)')
          .matches,
        onLeaving: () => {
          state.leaving = true;
        },
        // The session exists by now: if the animation cannot run, open the
        // page anyway instead of leaving the card half-way and busy.
      }).catch(() => {
        globalThis.location.assign(editAddress(island.next));
      });
    },
  };
  return hydrateRoot(
    container,
    <LoginRoot host={host} island={island} behaviour={behaviour} />,
  );
}
