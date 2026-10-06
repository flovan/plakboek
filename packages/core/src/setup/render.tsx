/**
 * The setup screens (D-12, D-13): server-rendered English HTML with one inline
 * stylesheet and no script. Every dynamic value (a submitted name, an email, a
 * transport error) goes through `renderToStaticMarkup`, so React escapes it;
 * nothing here builds markup by string concatenation except the one trusted
 * constant stylesheet.
 *
 * All copy is the first-run contract's, verbatim.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BootstrapField } from '../runtime/bootstrap.js';
import { SETUP_STYLES } from './styles.js';

/** One problem with one field; `message` is the exact line shown. */
export type SetupIssue = {
  readonly field: BootstrapField;
  readonly message: string;
};

/** What a failed submit keeps. Passwords are never preserved. */
export type SetupValues = { readonly name?: string; readonly email?: string };

/** What the done screen shows under "Send test email". */
export type TestEmailResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'console' }
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'failed'; readonly detail: string };

export const SETUP_PATH = '/cms/setup';
export const TEST_EMAIL_PATH = '/cms/setup/test-email';

function Document({
  title,
  className,
  children,
}: {
  readonly title: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{title}</title>
        {/* The stylesheet is a trusted constant; its hash is in the CSP. */}
        <style dangerouslySetInnerHTML={{ __html: SETUP_STYLES }} />
      </head>
      <body>
        <main {...(className === undefined ? {} : { className })}>
          {children}
        </main>
      </body>
    </html>
  );
}

function toHtml(element: ReactNode): string {
  return `<!DOCTYPE html>${renderToStaticMarkup(element)}`;
}

type FieldProps = {
  readonly id: BootstrapField;
  readonly label: string;
  readonly type: 'text' | 'email' | 'password';
  readonly autoComplete: string;
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly autoFocus?: boolean;
  readonly hint?: string;
  readonly value?: string;
  readonly error?: string;
};

function Field(props: FieldProps) {
  const { id, hint, error } = props;
  const describedBy = [
    hint === undefined ? undefined : `${id}-hint`,
    error === undefined ? undefined : `${id}-error`,
  ].filter((part): part is string => part !== undefined);

  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        name={id}
        type={props.type}
        autoComplete={props.autoComplete}
        required
        {...(props.maxLength === undefined
          ? {}
          : { maxLength: props.maxLength })}
        {...(props.minLength === undefined
          ? {}
          : { minLength: props.minLength })}
        {...(props.autoFocus === true ? { autoFocus: true } : {})}
        {...(props.value === undefined ? {} : { defaultValue: props.value })}
        {...(error === undefined ? {} : { 'aria-invalid': true })}
        {...(describedBy.length === 0
          ? {}
          : { 'aria-describedby': describedBy.join(' ') })}
      />
      {hint === undefined ? null : (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className="error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The first message for a field, which is the one shown inline. */
function errorFor(
  issues: readonly SetupIssue[],
  field: BootstrapField,
): string | undefined {
  return issues.find((issue) => issue.field === field)?.message;
}

/**
 * The first-run form. With `issues` it is the 422 re-render: the error summary
 * takes focus, name and email are kept, both password fields come back empty
 * and no field autofocuses.
 */
export function renderSetupForm(
  options: {
    readonly values?: SetupValues;
    readonly issues?: readonly SetupIssue[];
  } = {},
): string {
  const issues = options.issues ?? [];
  const values = options.values ?? {};
  const failed = issues.length > 0;

  return toHtml(
    <Document title="Set up Plakboek">
      <h1>Set up Plakboek</h1>
      <p>
        Create the first account for this installation. It becomes the
        superadmin.
      </p>
      <p className="note">
        Anyone who can reach this page can create the account, so finish setup
        before sharing the address.
      </p>
      {failed ? (
        <div className="summary" role="alert" tabIndex={-1} autoFocus>
          <h2 className="label">Fix the following and try again</h2>
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.field}:${issue.message}`}>
                <a href={`#${issue.field}`}>{issue.message}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form method="post" action={SETUP_PATH}>
        <Field
          id="name"
          label="Name"
          type="text"
          autoComplete="name"
          maxLength={200}
          {...(values.name === undefined ? {} : { value: values.name })}
          {...optionalError(issues, 'name')}
        />
        <Field
          id="email"
          label="Email address"
          type="email"
          autoComplete="email"
          maxLength={320}
          autoFocus={!failed}
          hint="This account receives sign-in and password-reset emails."
          {...(values.email === undefined ? {} : { value: values.email })}
          {...optionalError(issues, 'email')}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          hint="At least 12 characters. A passphrase works well."
          {...optionalError(issues, 'password')}
        />
        <Field
          id="passwordConfirm"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          {...optionalError(issues, 'passwordConfirm')}
        />
        <div className="actions">
          <button type="submit" className="button primary">
            Create superadmin
          </button>
        </div>
      </form>
    </Document>,
  );
}

function optionalError(
  issues: readonly SetupIssue[],
  field: BootstrapField,
): { readonly error?: string } {
  const error = errorFor(issues, field);
  return error === undefined ? {} : { error };
}

/** The 409 and 503 screens: fixed copy, no form, never a driver message. */
export function renderSetupUnavailable(kind: 'race' | 'database'): string {
  if (kind === 'race') {
    return toHtml(
      <Document title="Setup is already complete">
        <h1>Setup is already complete</h1>
        <p>
          Someone created the first account while this page was open. If that
          was not you, check the installation before continuing.
        </p>
        <a className="button primary" href="/">
          View your site
        </a>
      </Document>,
    );
  }
  return toHtml(
    <Document title="The database is not ready">
      <h1>The database is not ready</h1>
      <p>
        Run <code>pnpm plakboek migrate</code>, then reload this page.
      </p>
    </Document>,
  );
}

function resultText(email: string, result: TestEmailResult): string {
  switch (result.kind) {
    case 'sent':
      return `Test email sent to ${email}. Check the inbox and the spam folder.`;
    case 'console':
      return 'No SMTP server is configured, so the email was printed to the server console instead.';
    case 'unconfigured':
      return 'No SMTP server is configured. Set the PLAKBOEK_SMTP_* variables to send email. Setup is complete either way.';
    case 'failed':
      return `The test email could not be sent: ${result.detail}. Check the PLAKBOEK_SMTP_* settings and try again. Setup is complete either way.`;
  }
}

/**
 * The response to a successful setup, and to every "Send test email": no
 * session is created (D-13), "View your site" is always visible, and the
 * result of a test email sits directly under its button.
 */
export function renderSetupComplete(options: {
  readonly email: string;
  readonly token: string;
  readonly homePublished: boolean;
  readonly result?: TestEmailResult;
}): string {
  const { email, token, homePublished, result } = options;
  const created = homePublished
    ? `The superadmin account for ${email} was created and your home page is published.`
    : `The superadmin account for ${email} was created.`;
  const succeeded = result?.kind === 'sent' || result?.kind === 'console';

  return toHtml(
    <Document title="Setup complete" className="done">
      <h1>Setup complete</h1>
      <p className="wrap">{created}</p>
      <p className="note">
        Sign-in arrives with the editor in a later release, so there is nothing
        to log in to yet.
      </p>
      <div className="actions">
        <a className="button primary" href="/">
          View your site
        </a>
      </div>
      <hr />
      <h2 className="label">Check email delivery</h2>
      <p className="note wrap">{`Sends a real sign-in email template to ${email}.`}</p>
      <form method="post" action={TEST_EMAIL_PATH}>
        <input type="hidden" name="token" defaultValue={token} />
        <button type="submit" className="button secondary">
          Send test email
        </button>
      </form>
      {result === undefined ? null : (
        <p className="result wrap" role={succeeded ? 'status' : 'alert'}>
          {resultText(email, result)}
        </p>
      )}
    </Document>,
  );
}
