import {
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { CMS_LOGIN_PATH } from '@plakboek/render';
import {
  groupSetupKey,
  parseOtpauthUri,
  type OtpauthKey,
} from '../../client/login/enrol.js';
import {
  CODE_FIELD_MAX_LENGTH,
  failureMessage,
  normaliseCode,
  validateCode,
  validatePassword,
  type AuthFailure,
} from '../../client/login/validation.js';
import { STRINGS } from '../strings.js';
import {
  StepFocusContext,
  useLoginBehaviour,
  type SignedInUser,
} from './behaviour.js';
import {
  LoginCard,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  TEXT_LINK,
} from './card.js';
import { ErrorBox, Field, PrimaryButton } from './fields.js';

export type EnrolStepProps = {
  readonly next: string;
  /**
   * A wrong code was entered. Returns true when it was the last one the
   * account allows, which the card knows to be the lockout. Absent where the
   * step is only painted (the server).
   */
  readonly onWrongCode?: () => boolean;
  /** The account is locked: go to the lockout step. */
  readonly onLockout?: () => void;
};

/**
 * Where the set-up is. Each stage holds only what it still needs, so moving
 * on drops what the stage before it knew: the key goes when the code has
 * been accepted, and the backup codes go when the card does. Nothing here is
 * ever written to the address, the page's data island, the browser's
 * storage or the console.
 */
type Stage =
  | { readonly name: 'confirm' }
  | {
      readonly name: 'key';
      readonly uri: string;
      readonly key: OtpauthKey;
      readonly backupCodes: readonly string[];
    }
  | {
      readonly name: 'backup';
      readonly backupCodes: readonly string[];
      readonly user: SignedInUser;
    };

/** What one failed attempt shows: the failure and a count, so the same
 * failure twice in a row still gives the box a new element to focus. */
type Failure = { readonly failure: AuthFailure; readonly attempt: number };

function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * A "Copy" button and the line that confirms it. The line is always in the
 * page, empty until the copy succeeded, so a screen reader announces the
 * change. A browser that refuses the clipboard says nothing: the text is
 * still on screen to select.
 */
function CopyButton(props: {
  readonly label: string;
  readonly done: string;
  readonly text: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await globalThis.navigator.clipboard.writeText(props.text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className={SECONDARY_BUTTON}
        onClick={() => {
          void copy();
        }}
      >
        {props.label}
      </button>
      <p
        role="status"
        className="m-0 mt-2 min-h-6 text-center text-body text-text-muted"
      >
        {copied ? props.done : ''}
      </p>
    </>
  );
}

/** Confirm the password, then ask the auth service for a key. */
function ConfirmStage(
  props: EnrolStepProps & {
    readonly onEnabled: (stage: Extract<Stage, { name: 'key' }>) => void;
  },
): ReactElement {
  const { next, onEnabled, onLockout } = props;
  const behaviour = useLoginBehaviour();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (behaviour === null || busyRef.current) return;
    const password = fieldText(new FormData(event.currentTarget), 'password');
    const problem = validatePassword(password);
    setPasswordError(problem);
    setFailed(null);
    if (problem !== null) {
      passwordRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const result = await behaviour.auth.enableTwoFactor(password);
    if (result.status === 'enabled') {
      const key = parseOtpauthUri(result.setupUri);
      if (key !== null) {
        onEnabled({
          name: 'key',
          uri: result.setupUri,
          key,
          backupCodes: result.backupCodes,
        });
        return;
      }
    }
    const failure: AuthFailure =
      result.status === 'failed' ? result.failure : 'server';
    if (failure === 'lockout') {
      onLockout?.();
      return;
    }
    if (failure === 'password' && passwordRef.current !== null) {
      passwordRef.current.value = '';
    }
    setFailed((previous) => ({
      failure,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
    busyRef.current = false;
    setBusy(false);
  }

  return (
    <LoginCard
      key="confirm"
      heading={STRINGS['enrol.confirm.heading']}
      body={STRINGS['enrol.confirm.body']}
      next={next}
    >
      <form
        method="post"
        action={CMS_LOGIN_PATH}
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          id="plakboek-login-enrol-password"
          name="password"
          label={STRINGS['login.signIn.password.label']}
          type="password"
          autoComplete="current-password"
          autoFocus
          readOnly={busy}
          error={passwordError}
          inputRef={passwordRef}
        />
        <div className="mt-6">
          {failed === null ? null : (
            <ErrorBox
              key={failed.attempt}
              message={failureMessage(failed.failure)}
            />
          )}
          <PrimaryButton busy={busy} busyLabel={STRINGS['loading.checking']}>
            {STRINGS['enrol.confirm.submit']}
          </PrimaryButton>
        </div>
      </form>
    </LoginCard>
  );
}

/** Show the key, take the first code from the authenticator app. */
function KeyStage(
  props: EnrolStepProps & {
    readonly stage: Extract<Stage, { name: 'key' }>;
    readonly onVerified: (stage: Extract<Stage, { name: 'backup' }>) => void;
  },
): ReactElement {
  const { next, stage, onVerified, onWrongCode, onLockout } = props;
  const behaviour = useLoginBehaviour();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (behaviour === null || busyRef.current) return;
    const code = fieldText(new FormData(event.currentTarget), 'code');
    const problem = validateCode(code);
    setCodeError(problem);
    setFailed(null);
    if (problem !== null) {
      codeRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const result = await behaviour.auth.verifyTotp(normaliseCode(code));
    if (result.status === 'verified') {
      onVerified({
        name: 'backup',
        backupCodes: stage.backupCodes,
        user: result.user,
      });
      return;
    }
    if (result.failure === 'lockout') {
      onLockout?.();
      return;
    }
    if (result.failure === 'code' && onWrongCode?.() === true) {
      onLockout?.();
      return;
    }
    setFailed((previous) => ({
      failure: result.failure,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
    busyRef.current = false;
    setBusy(false);
  }

  return (
    <LoginCard
      key="key"
      heading={STRINGS['enrol.key.heading']}
      body={STRINGS['enrol.key.body']}
      next={next}
    >
      <p className="m-0 mb-2 text-body font-semibold text-text">
        {STRINGS['enrol.key.label']}
      </p>
      <p
        id="plakboek-enrol-key"
        className="m-0 mb-4 rounded-lg border border-control-border bg-surface-muted p-4 font-mono text-body text-text wrap-anywhere select-all"
      >
        {groupSetupKey(stage.key.secret)}
      </p>
      <CopyButton
        label={STRINGS['enrol.key.copy']}
        done={STRINGS['enrol.key.copied']}
        text={stage.key.secret}
      />
      <p className="m-0 mb-6 mt-2 text-center">
        <a href={stage.uri} className={TEXT_LINK}>
          {STRINGS['enrol.key.link']}
        </a>
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          id="plakboek-login-code"
          name="code"
          label={STRINGS['login.twoFactor.code.label']}
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={CODE_FIELD_MAX_LENGTH}
          hint={STRINGS['enrol.key.codeHint']}
          readOnly={busy}
          error={codeError}
          inputRef={codeRef}
        />
        <div className="mt-6">
          {failed === null ? null : (
            <ErrorBox
              key={failed.attempt}
              message={failureMessage(failed.failure)}
            />
          )}
          <PrimaryButton busy={busy} busyLabel={STRINGS['loading.verifying']}>
            {STRINGS['enrol.key.submit']}
          </PrimaryButton>
        </div>
      </form>
    </LoginCard>
  );
}

/** Show the backup codes once; acknowledging them hands over to edit mode. */
function BackupStage(props: {
  readonly next: string;
  readonly stage: Extract<Stage, { name: 'backup' }>;
}): ReactElement {
  const { next, stage } = props;
  const behaviour = useLoginBehaviour();
  const doneRef = useRef(false);

  function acknowledge(): void {
    if (behaviour === null || doneRef.current) return;
    doneRef.current = true;
    // Two-step sign-in is on now, so the hand-over goes straight to the
    // shell; the server re-checks that on the next request either way.
    behaviour.signedIn({ ...stage.user, twoFactorEnabled: true });
  }

  return (
    <LoginCard
      key="backup"
      heading={STRINGS['enrol.backup.heading']}
      body={STRINGS['enrol.backup.body']}
      next={next}
    >
      <ul className="m-0 mb-4 grid list-none grid-cols-2 gap-2 rounded-lg border border-control-border bg-surface-muted p-4 font-mono text-body text-text">
        {stage.backupCodes.map((code) => (
          <li key={code} className="wrap-anywhere select-all">
            {code}
          </li>
        ))}
      </ul>
      <CopyButton
        label={STRINGS['enrol.backup.copy']}
        done={STRINGS['enrol.backup.copied']}
        text={stage.backupCodes.join('\n')}
      />
      <div className="mt-4">
        <button type="button" className={PRIMARY_BUTTON} onClick={acknowledge}>
          {STRINGS['enrol.backup.submit']}
        </button>
      </div>
    </LoginCard>
  );
}

/**
 * Two-step sign-in set-up for a role that requires it: confirm the password,
 * add the setup key to an authenticator app and prove it with a first code,
 * save the backup codes, then on to edit mode. The server paints the first
 * sub-step as static markup; the client makes it work and moves through the
 * rest. Every sub-step after the first takes focus on its heading.
 */
export function EnrolStep(props: EnrolStepProps): ReactElement {
  const [stage, setStage] = useState<Stage>({ name: 'confirm' });
  const moved = useContext(StepFocusContext);

  function body(): ReactElement {
    switch (stage.name) {
      case 'confirm':
        return <ConfirmStage {...props} onEnabled={setStage} />;
      case 'key':
        return <KeyStage {...props} stage={stage} onVerified={setStage} />;
      case 'backup':
        return <BackupStage next={props.next} stage={stage} />;
    }
  }

  return (
    <StepFocusContext.Provider value={moved || stage.name !== 'confirm'}>
      {body()}
    </StepFocusContext.Provider>
  );
}
