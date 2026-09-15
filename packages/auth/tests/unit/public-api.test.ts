/**
 * The `@plakboek/auth` entry point is a contract. This suite holds that
 * contract as a literal list and fails when any of three things drifts from
 * it: what `src/index.ts` actually exports, what the README's "Public API"
 * tables document, and the closed-route list in the README's security
 * notes. It also proves that importing the entry point has no side effects
 * and that nothing that could mint a credential or write around the audited
 * paths is reachable from it.
 *
 * Adding an export means adding it here, to the barrel and to the README in
 * the same change.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const INDEX_PATH = fileURLToPath(
  new URL('../../src/index.ts', import.meta.url),
);
const README_PATH = fileURLToPath(new URL('../../README.md', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

type ValueKind = 'function' | 'class' | 'constant';

/** Every value the entry point exports, grouped as the barrel groups them. */
const PUBLIC_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  // config
  createAuth: 'function',
  AuthConfigError: 'class',
  SESSION_EXPIRES_IN_SECONDS: 'constant',
  SESSION_UPDATE_AGE_SECONDS: 'constant',
  IMPERSONATION_SESSION_TTL_SECONDS: 'constant',
  SET_PASSWORD_TOKEN_TTL_SECONDS: 'constant',
  MAGIC_LINK_TTL_SECONDS: 'constant',
  TWO_FACTOR_CODE_TTL_SECONDS: 'constant',
  TWO_FACTOR_LOCKOUT: 'constant',
  DISABLED_AUTH_PATHS: 'constant',
  // password-policy
  PASSWORD_MIN_LENGTH: 'constant',
  assertPasswordPolicy: 'function',
  PasswordPolicyError: 'class',
  // first-user
  createUserWithRole: 'function',
  SUPERADMIN_ROLE_KEY: 'constant',
  // audit
  createAuditRecorder: 'function',
  runAuditedMutation: 'function',
  PermissionDeniedError: 'class',
  AuditWriteError: 'class',
  // audit-redaction
  REDACTED_KEYS: 'constant',
  REDACTION_MARKER: 'constant',
  redactAuditPayload: 'function',
  // audit-prune
  pruneAuditLog: 'function',
  AUDIT_RETENTION_DAYS: 'constant',
  // tokens
  consumeSingleUseToken: 'function',
  issueSingleUseToken: 'function',
  InvalidOrExpiredTokenError: 'class',
  TOKEN_PURPOSES: 'constant',
  // credentials
  requestPasswordLink: 'function',
  completeSetPassword: 'function',
  CredentialWriteError: 'class',
  PASSWORD_LINK_PATHS: 'constant',
  CREDENTIAL_SET_ACTION: 'constant',
  // invite
  inviteUser: 'function',
  resendSetPasswordLink: 'function',
  InviteDeliveryError: 'class',
  InvalidInviteError: 'class',
  InviteWriteError: 'class',
  USER_INVITE_ACTION: 'constant',
  USER_RESEND_SET_PASSWORD_ACTION: 'constant',
  // impersonation
  startImpersonation: 'function',
  stopImpersonation: 'function',
  assertImpersonationTargetAllowed: 'function',
  auditActorFromSession: 'function',
  ImpersonationTargetForbiddenError: 'class',
  ImpersonationSessionError: 'class',
  // two-factor-gate
  assertTwoFactorSatisfied: 'function',
  needsTwoFactorEnrolment: 'function',
  isTwoFactorRequiredForRole: 'function',
  TWO_FACTOR_REQUIRED_ROLE_KEYS: 'constant',
  TWO_FACTOR_ENROLMENT_PATH: 'constant',
  TwoFactorEnrolmentRequiredError: 'class',
  // email/sender
  createMailSender: 'function',
  createSmtpSender: 'function',
  createConsoleSender: 'function',
  MailSenderConfigError: 'class',
  // email/render
  renderAuthEmail: 'function',
  AUTH_EMAIL_KINDS: 'constant',
  // email/types
  MailSendError: 'class',
});

/** Every type the entry point exports. Types leave no runtime trace, so this
 * list is compared with the barrel's source and with the README. */
const PUBLIC_TYPES: readonly string[] = Object.freeze([
  // config
  'Auth',
  'CreateAuthOptions',
  'RenderAuthEmail',
  // first-user
  'CreateUserInput',
  'CreateUserOptions',
  'CreateUserResult',
  'UserCreationExecutor',
  // audit
  'AuditActor',
  'AuditDatabase',
  'AuditDeps',
  'AuditEntryInput',
  'AuditFailureHook',
  'AuditRecorder',
  'AuditTransaction',
  'AuditWriteFailure',
  'AuditedMutation',
  // audit-redaction
  'RedactAuditPayloadOptions',
  // audit-prune
  'PruneAuditLogOptions',
  // tokens
  'TokenPurpose',
  'TokenDatabase',
  'TokenTransaction',
  'IssueSingleUseTokenInput',
  'ConsumeSingleUseTokenInput',
  'TokenClockOptions',
  'AuthorizeWithToken',
  // credentials
  'PasswordLinkPurpose',
  'PasswordLinkRequestOutcome',
  'PasswordLinkProbe',
  'RequestPasswordLinkDeps',
  'RequestPasswordLinkInput',
  'CompleteSetPasswordDeps',
  'CompleteSetPasswordInput',
  // invite
  'InviteDeps',
  'InviteUserInput',
  'InviteUserResult',
  'ResendSetPasswordLinkInput',
  'InviteField',
  // impersonation
  'ImpersonatableSession',
  'ImpersonationParty',
  'ImpersonationRefusalReason',
  'ImpersonationDeps',
  'ImpersonationSessionResult',
  'ImpersonationSessionRefusalReason',
  // two-factor-gate
  'TwoFactorSubject',
  // email/sender
  'SmtpOptions',
  'SmtpTransport',
  'SmtpTransportConfig',
  'SmtpTransportMessage',
  'CreateSmtpTransport',
  'CreateSmtpSenderOptions',
  'CreateConsoleSenderOptions',
  'CreateMailSenderOptions',
  'MailSenderKind',
  // email/render
  'AuthEmailKind',
  // email/types
  'MailMessage',
  'MailSender',
]);

/**
 * Names that must stay unreachable from the entry point. The token value
 * generator and identifier builder would let a consumer write a
 * `verification` row that bypasses the issue path (T-02-59); the schema
 * tables would let one write `audit_log` or `session` outside the audited
 * paths (T-02-60); the rest are internal locks, helpers and hooks.
 */
const INTERNAL_NAMES: readonly string[] = Object.freeze([
  'generateTokenValue',
  'tokenIdentifier',
  'expiryFor',
  'isTokenUsable',
  'TOKEN_ISSUE_LOCK_CLASS',
  'FIRST_USER_LOCK_KEY',
  'storedEmailForm',
  'capImpersonationExpiry',
  'user',
  'session',
  'account',
  'verification',
  'twoFactor',
  'auditLog',
]);

/** One instance per exported error class, built with representative
 * arguments. A class missing here fails the naming case. */
const ERROR_FACTORIES: Readonly<
  Record<string, (Klass: new (...args: never[]) => unknown) => unknown>
> = Object.freeze({
  AuthConfigError: (K) => new (K as new (m: string) => unknown)('message'),
  PasswordPolicyError: (K) => new (K as new (n: number) => unknown)(12),
  PermissionDeniedError: (K) =>
    new (K as new (p: string, r: string) => unknown)('users:create', 'editor'),
  AuditWriteError: (K) =>
    new (K as new (p: string, a: string, c: unknown) => unknown)(
      'users:create',
      'user.invite',
      new Error('cause'),
    ),
  InvalidOrExpiredTokenError: (K) =>
    new (K as new (p: string) => unknown)('set-password'),
  CredentialWriteError: (K) =>
    new (K as new (f: unknown) => unknown)(new Error('failure')),
  InviteDeliveryError: (K) =>
    new (K as new (u: string, d: string) => unknown)('user-id', 'example.com'),
  InvalidInviteError: (K) => new (K as new (f: string) => unknown)('email'),
  InviteWriteError: (K) =>
    new (K as new (f: unknown) => unknown)(new Error('failure')),
  ImpersonationTargetForbiddenError: (K) =>
    new (K as new (t: string, r: string) => unknown)(
      'user-id',
      'target-is-superadmin',
    ),
  ImpersonationSessionError: (K) =>
    new (K as new (r: string) => unknown)('no-session'),
  TwoFactorEnrolmentRequiredError: (K) =>
    new (K as new (r: string) => unknown)('superadmin'),
  MailSenderConfigError: (K) =>
    new (K as new (m: string) => unknown)('message'),
  MailSendError: (K) =>
    new (K as new (r: string) => unknown)('someone@example.com'),
});

type Documented = { readonly name: string; readonly kind: string };

/** The lines of one `## heading` section, up to the next `## ` heading.
 * An absent section yields no lines. */
function sectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    return [];
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every `| \`name\` | kind | purpose |` row in the README's Public API
 * section. */
function documentedExports(): Documented[] {
  const readme = readFileSync(README_PATH, 'utf8');
  return sectionLines(readme, 'Public API').flatMap((line) => {
    const match =
      /^\|\s*`([A-Za-z_$][\w$]*)`\s*\|\s*(function|class|constant|type)\s*\|/.exec(
        line,
      );
    return match === null ? [] : [{ name: match[1]!, kind: match[2]! }];
  });
}

/** Every name inside an `export type { ... } from` statement of the barrel. */
function barrelTypeNames(): string[] {
  const source = readFileSync(INDEX_PATH, 'utf8');
  return [...source.matchAll(/export type \{([^}]*)\}\s*from/g)].flatMap(
    (match) =>
      (match[1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((a, b) => a.localeCompare(b));
}

function kindOf(value: unknown): ValueKind {
  if (typeof value !== 'function') {
    return 'constant';
  }
  return Function.prototype.toString.call(value).startsWith('class')
    ? 'class'
    : 'function';
}

describe('importing @plakboek/auth', () => {
  // Runs first, before anything else in this file loads the entry point.
  it('opens no connection, prints nothing and reads no environment variable from its own code', async () => {
    const connects = vi.spyOn(net.Socket.prototype, 'connect');
    const consoleCalls = (
      ['log', 'info', 'warn', 'error', 'debug'] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const ownEnvReads: string[] = [];
    const realEnv = process.env;
    const previousStackLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 50;
    // A read counts as the package's own when the frame that called the trap
    // is in `src/`; a dependency's read has its own frame there. Frames:
    // [0] message, [1] this function, [2] the trap, [3] the reader.
    const recordIfOwn = (key: string | symbol): void => {
      const frames = (new Error('env read').stack ?? '').split('\n');
      if (frames[3]?.includes(SRC_DIR) === true) {
        ownEnvReads.push(String(key));
      }
    };
    process.env = new Proxy(realEnv, {
      get(target, key, receiver) {
        recordIfOwn(key);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        recordIfOwn(key);
        return Reflect.has(target, key);
      },
    });

    try {
      vi.resetModules();
      const api = await import('../../src/index.js');
      expect(Object.keys(api).length).toBeGreaterThan(0);
    } finally {
      process.env = realEnv;
      Error.stackTraceLimit = previousStackLimit;
    }

    try {
      expect(ownEnvReads).toEqual([]);
      expect(connects).not.toHaveBeenCalled();
      for (const call of consoleCalls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('the @plakboek/auth public surface', () => {
  it('exports every documented value, each of its expected kind', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    const actual = Object.fromEntries(
      Object.keys(PUBLIC_VALUES).map((name) => [name, kindOf(api[name])]),
    );
    expect(actual).toEqual(PUBLIC_VALUES);
  });

  it('exports no value beyond the documented list', async () => {
    const api = await import('../../src/index.js');
    expect(sorted(Object.keys(api))).toEqual(
      sorted(Object.keys(PUBLIC_VALUES)),
    );
  });

  it('keeps token internals, locks and the schema unreachable', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    for (const name of INTERNAL_NAMES) {
      expect({ name, value: api[name] }).toEqual({ name, value: undefined });
    }
    expect(api['generateTokenValue']).toBeUndefined();
    expect(api['tokenIdentifier']).toBeUndefined();
  });

  it('re-exports each module by name, with no wildcard or default export', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');
    expect(source).not.toMatch(/export \*/);
    expect(source).not.toMatch(/export default/);
    expect(source).not.toMatch(/from '\.\/(schema)\.js'/);
    expect(sorted(barrelTypeNames())).toEqual(sorted(PUBLIC_TYPES));
  });

  it('names every exported error class after itself, as an Error subclass', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    const classes = Object.entries(PUBLIC_VALUES)
      .filter(([, kind]) => kind === 'class')
      .map(([name]) => name);
    expect(sorted(Object.keys(ERROR_FACTORIES))).toEqual(sorted(classes));

    for (const name of classes) {
      expect({ name, kind: kindOf(api[name]) }).toEqual({
        name,
        kind: 'class',
      });
      const Klass = api[name] as new (...args: never[]) => unknown;
      const factory = ERROR_FACTORIES[name]!;
      const instance = factory(Klass);
      expect({
        name,
        isError: instance instanceof Error,
        ownName: (instance as Error).name,
      }).toEqual({ name, isError: true, ownName: name });
    }
  });
});

describe('README drift', () => {
  it('documents exactly the exported values in its Public API tables, with the same kinds', () => {
    const documented = documentedExports().filter((row) => row.kind !== 'type');
    const byName = Object.fromEntries(
      documented.map((row) => [row.name, row.kind]),
    );
    expect(documented).toHaveLength(Object.keys(byName).length);
    expect(byName).toEqual(PUBLIC_VALUES);
  });

  it('documents exactly the exported types in its Public API tables', () => {
    const documented = documentedExports()
      .filter((row) => row.kind === 'type')
      .map((row) => row.name);
    expect(sorted(documented)).toEqual(sorted(PUBLIC_TYPES));
  });

  it('lists every closed HTTP route in its security notes, and nothing else', async () => {
    const { DISABLED_AUTH_PATHS } = await import('../../src/config.js');
    const readme = readFileSync(README_PATH, 'utf8');
    const listed = sectionLines(readme, 'Security notes').flatMap((line) => {
      const match = /^\s*- `(\/[^`\s]*)`/.exec(line);
      return match === null ? [] : [match[1]!];
    });
    expect(sorted(listed)).toEqual(sorted(DISABLED_AUTH_PATHS));
  });
});
