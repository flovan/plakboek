import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import {
  failureMessage,
  maskEmail,
  normaliseCode,
  validateCode,
  type AuthFailure,
} from '../../client/login/validation.js';
import { formatString, STRINGS } from '../strings.js';
import { useLoginBehaviour, type CodeResult } from './behaviour.js';
import { LoginCard, TEXT_LINK } from './card.js';
import { ErrorBox, Field, PrimaryButton } from './fields.js';

/** A text field's value from a submitted form. */
function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** What a code step tells the card around it. */
export type CodeStepHandlers = {
  readonly next: string;
  /**
   * A wrong code was entered. Returns true when it was the last one the
   * account allows, which the card knows to be the lockout.
   */
  readonly onWrongCode: () => boolean;
  /** The account (or the pending sign-in) is locked: go to the lockout step. */
  readonly onLockout: () => void;
};

type Failure = { readonly failure: AuthFailure; readonly attempt: number };

/**
 * The form both code steps share: one field for the six digits, one primary
 * button and the single error box. It checks the code is six digits before
 * sending anything, counts a wrong code and lets the card decide when that
 * means lockout, and hands a verified user to the hand-over.
 */
function useCodeForm(
  verify: (code: string) => Promise<CodeResult>,
  handlers: CodeStepHandlers,
) {
  const behaviour = useLoginBehaviour();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (behaviour === null || busyRef.current) return;
    const code = fieldText(new FormData(event.currentTarget), 'code');
    const problem = validateCode(code);
    setCodeError(problem);
    setFailed(null);
    if (problem !== null) {
      inputRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const result = await verify(normaliseCode(code));
    if (result.status === 'verified') {
      // The card stays as it is while the hand-over takes it.
      behaviour.signedIn(result.user);
      return;
    }
    if (result.failure === 'lockout') {
      handlers.onLockout();
      return;
    }
    if (result.failure === 'code' && handlers.onWrongCode()) {
      handlers.onLockout();
      return;
    }
    setFailed((previous) => ({
      failure: result.failure,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
    busyRef.current = false;
    setBusy(false);
  }

  return { behaviour, busy, codeError, failed, inputRef, submit, setFailed };
}

/** The code field, the error box and the Verify button of a code step. */
function CodeForm(props: {
  readonly form: ReturnType<typeof useCodeForm>;
}): ReactElement {
  const { busy, codeError, failed, inputRef, submit } = props.form;
  return (
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
        maxLength={6}
        readOnly={busy}
        error={codeError}
        inputRef={inputRef}
      />
      <div className="mt-6">
        {failed === null ? null : (
          <ErrorBox
            key={failed.attempt}
            message={failureMessage(failed.failure)}
          />
        )}
        <PrimaryButton busy={busy} busyLabel={STRINGS['loading.verifying']}>
          {STRINGS['login.twoFactor.submit']}
        </PrimaryButton>
      </div>
    </form>
  );
}

export type TwoFactorStepProps = CodeStepHandlers & {
  /** The emailed code was asked for and is on its way. */
  readonly onEmailSent: () => void;
};

/**
 * The authenticator step: the six digits the app shows. "Email me a code
 * instead" asks the server to mail one and moves on to the emailed-code
 * step; if that fails, the box of this step says why.
 */
export function TwoFactorStep(props: TwoFactorStepProps): ReactElement {
  const { next, onEmailSent } = props;
  const behaviour = useLoginBehaviour();
  const form = useCodeForm(
    (code) =>
      behaviour === null
        ? Promise.resolve({ status: 'failed', failure: 'server' })
        : behaviour.auth.verifyTotp(code),
    props,
  );
  const [sending, setSending] = useState(false);

  async function sendEmailCode(): Promise<void> {
    if (behaviour === null || sending) return;
    setSending(true);
    const result = await behaviour.auth.sendOtp();
    if (result.status === 'sent') {
      onEmailSent();
      return;
    }
    if (result.failure === 'lockout') {
      props.onLockout();
      return;
    }
    form.setFailed((previous) => ({
      failure: result.failure,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
    setSending(false);
  }

  return (
    <LoginCard
      heading={STRINGS['login.twoFactor.totp.heading']}
      body={STRINGS['login.twoFactor.totp.body']}
      next={next}
      secondary={
        <button
          type="button"
          disabled={sending}
          aria-disabled={sending ? true : undefined}
          onClick={() => {
            void sendEmailCode();
          }}
          className={TEXT_LINK}
        >
          {sending
            ? STRINGS['loading.sending']
            : STRINGS['login.twoFactor.totp.useEmail']}
        </button>
      }
    >
      <CodeForm form={form} />
    </LoginCard>
  );
}

export type EmailCodeStepProps = CodeStepHandlers & {
  /** The address the sign-in was started with, shown masked. */
  readonly email: string;
  /** Back to the authenticator step. */
  readonly onUseAuthenticator: () => void;
};

/**
 * The emailed-code step. The address is masked to its first character and its
 * domain. "Resend code" asks for another code; "Use your authenticator app
 * instead" is always offered, because the only way to turn two-step sign-in
 * on in this release enrols an authenticator.
 */
export function EmailCodeStep(props: EmailCodeStepProps): ReactElement {
  const { next, email, onUseAuthenticator } = props;
  const behaviour = useLoginBehaviour();
  const form = useCodeForm(
    (code) =>
      behaviour === null
        ? Promise.resolve({ status: 'failed', failure: 'server' })
        : behaviour.auth.verifyOtp(code),
    props,
  );
  const [sending, setSending] = useState(false);

  async function resend(): Promise<void> {
    if (behaviour === null || sending) return;
    setSending(true);
    const result = await behaviour.auth.sendOtp();
    if (result.status === 'failed') {
      if (result.failure === 'lockout') {
        props.onLockout();
        return;
      }
      form.setFailed((previous) => ({
        failure: result.failure,
        attempt: (previous?.attempt ?? 0) + 1,
      }));
    }
    setSending(false);
  }

  return (
    <LoginCard
      heading={STRINGS['login.twoFactor.email.heading']}
      body={formatString('login.twoFactor.email.body', {
        maskedEmail: maskEmail(email),
      })}
      next={next}
      secondary={
        <>
          <button
            type="button"
            disabled={sending}
            aria-disabled={sending ? true : undefined}
            onClick={() => {
              void resend();
            }}
            className={TEXT_LINK}
          >
            {sending
              ? STRINGS['loading.sending']
              : STRINGS['login.twoFactor.email.resend']}
          </button>
          <button
            type="button"
            onClick={onUseAuthenticator}
            className={TEXT_LINK}
          >
            {STRINGS['login.twoFactor.email.useTotp']}
          </button>
        </>
      }
    >
      <CodeForm form={form} />
    </LoginCard>
  );
}
