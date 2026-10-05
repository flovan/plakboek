/**
 * First-run bootstrap (D-08, D-11): the one function the setup page and the
 * CLI both call. It creates the installation's first user, who is always the
 * superadmin, and publishes the configured seed as the `home` page, all in
 * one transaction, acting as that new user through the audited mutation path
 * so the audit log is attributable from the first row.
 *
 * Race safety (F11): `createUserWithRole` takes a transaction-scoped advisory
 * lock before it looks for existing users, and that lock is held until the
 * OUTER transaction here ends. Two concurrent bootstraps therefore serialise:
 * the loser waits, then sees the winner's row, learns it was not the first
 * user, and throws, which rolls its user row back. A loser is never stored,
 * with any role.
 *
 * Never logged or returned: the password and its hash.
 */
import { randomUUID } from 'node:crypto';
import {
  PASSWORD_MIN_LENGTH,
  SUPERADMIN_ROLE_KEY,
  createAuditRecorder,
  createUserWithRole,
} from '@plakboek/auth';
import {
  createPage,
  getPage,
  insertBlock,
  publishPage,
  type PagesDeps,
} from '@plakboek/pages';
import { sql } from 'drizzle-orm';
import type { SeedBlock, SeedPage } from '../types.js';
import { isDatabaseNotReady, isUniqueViolation } from './db.js';
import type { Runtime } from './runtime.js';

const NAME_MAX_LENGTH = 200;
const EMAIL_MAX_LENGTH = 320;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type BootstrapInput = {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  /** When present, it must equal `password`. */
  readonly passwordConfirm?: string;
};

export type BootstrapField = 'name' | 'email' | 'password' | 'passwordConfirm';

/** One field problem; `message` is the exact copy shown to the operator. */
export type BootstrapIssue = {
  readonly field: BootstrapField;
  readonly message: string;
};

export type BootstrapResult = {
  readonly userId: string;
  /** The address as stored: trimmed and lower-cased. */
  readonly email: string;
  readonly homePublished: boolean;
  readonly homePath: '/';
};

/** The input failed validation. Issues never contain the password. */
export class BootstrapValidationError extends Error {
  readonly issues: readonly BootstrapIssue[];

  constructor(issues: readonly BootstrapIssue[]) {
    super(
      [
        'Fix the following and try again:',
        ...issues.map((i) => i.message),
      ].join('\n'),
    );
    this.name = 'BootstrapValidationError';
    this.issues = issues;
  }
}

/** The installation already has a user, or this call lost the first-user race. */
export class InstallationNotEmptyError extends Error {
  constructor() {
    super(
      'This installation already has users. Bootstrap only runs on an empty installation.',
    );
    this.name = 'InstallationNotEmptyError';
  }
}

/** The database is unreachable or not migrated. The message never carries a
 * host, name, port or driver text; the original error is the `cause`. */
export class DatabaseNotReadyError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super('The database is not ready', options);
    this.name = 'DatabaseNotReadyError';
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Field problems for a bootstrap input, in field order. Empty when valid. */
export function validateBootstrapInput(
  input: BootstrapInput,
): readonly BootstrapIssue[] {
  const issues: BootstrapIssue[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';

  if (name.length === 0) {
    issues.push({ field: 'name', message: 'Name: enter your name.' });
  } else if (codePointLength(name) > NAME_MAX_LENGTH) {
    issues.push({
      field: 'name',
      message: `Name: use at most ${NAME_MAX_LENGTH} characters.`,
    });
  }

  if (!EMAIL_PATTERN.test(email) || email.length > EMAIL_MAX_LENGTH) {
    issues.push({
      field: 'email',
      message: 'Email address: enter an address like name@example.com.',
    });
  }

  if (codePointLength(password) < PASSWORD_MIN_LENGTH) {
    issues.push({
      field: 'password',
      message: `Password: use at least ${PASSWORD_MIN_LENGTH} characters.`,
    });
  }

  if (
    input.passwordConfirm !== undefined &&
    input.passwordConfirm !== password
  ) {
    issues.push({
      field: 'passwordConfirm',
      message: 'Confirm password: the two passwords do not match.',
    });
  }

  return issues;
}

type Transaction = Parameters<
  Parameters<Runtime['db']['db']['transaction']>[0]
>[0];

/**
 * Creates and publishes the seed as the home page inside the caller's
 * transaction. The deps carry NO invalidator: a page that has never been
 * published cannot be in any cache, so no purge is owed, and a
 * transaction-bound recorder refuses after-commit registration anyway.
 */
async function publishSeedHome(
  runtime: Runtime,
  tx: Transaction,
  actor: { readonly userId: string; readonly roleKey: string },
  seed: SeedPage,
): Promise<void> {
  const { config, resolver } = runtime;
  const deps: PagesDeps = {
    db: tx,
    recorder: createAuditRecorder({ db: tx, resolver }),
    resolver,
    config: config.pages,
  };

  const page = await createPage(deps, actor, {
    locale: config.content.defaultLocale,
    title: seed.title,
    slug: config.homeSlug,
  });
  const owner = {
    ownerType: 'page' as const,
    ownerId: page.id,
    locale: page.locale,
  };

  // Every structural write bumps the page version, so it is re-read before
  // each one rather than counted.
  async function currentVersion(): Promise<number> {
    const current = await getPage(tx, page.id);
    if (current === null || current === undefined) {
      throw new Error('The seeded page disappeared during bootstrap');
    }
    return current.version;
  }

  async function insertNodes(
    nodes: readonly SeedBlock[],
    parentBlockId: string | null,
  ): Promise<void> {
    for (const node of nodes) {
      const block = await insertBlock(deps, actor, {
        owner,
        blockType: node.type,
        parentBlockId,
        ...(node.props === undefined ? {} : { props: node.props }),
        basePageVersion: await currentVersion(),
      });
      await insertNodes(node.children ?? [], block.id);
    }
  }

  await insertNodes(seed.blocks, null);
  await publishPage(deps, actor, {
    pageId: page.id,
    baseVersion: await currentVersion(),
  });
}

/**
 * Creates the first superadmin and publishes the seed home page. Throws
 * `BootstrapValidationError`, `InstallationNotEmptyError` or
 * `DatabaseNotReadyError`; anything else is an unexpected failure and
 * propagates unchanged.
 */
export async function bootstrapInstallation(
  runtime: Runtime,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const issues = validateBootstrapInput(input);
  if (issues.length > 0) throw new BootstrapValidationError(issues);

  const name = input.name.trim();
  const email = input.email.trim();

  try {
    // Fail fast, before the (deliberately slow) password hash. This is only
    // an optimisation and the first reachability probe; the lock inside the
    // transaction below is what makes the rule hold under concurrency.
    const [{ populated } = { populated: false }] = await runtime.db.sql<
      { populated: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM "user") AS populated`;
    if (populated) throw new InstallationNotEmptyError();

    const context = await runtime.auth.$context;
    const passwordHash = await context.password.hash(input.password);

    return await runtime.db.db.transaction(async (tx) => {
      let created: Awaited<ReturnType<typeof createUserWithRole>>;
      try {
        // Registered as `editor` so that losing the race can never leave a
        // privileged row behind; the first-user rule promotes the winner.
        created = await createUserWithRole(tx, {
          id: randomUUID(),
          email,
          name,
          roleKey: 'editor',
          passwordHash,
        });
      } catch (error) {
        // The same address as the winner's collides on the unique index
        // before the first-user check can report anything.
        if (isUniqueViolation(error)) throw new InstallationNotEmptyError();
        throw error;
      }
      if (!created.wasFirstUser) throw new InstallationNotEmptyError();

      const stored = await tx.execute<{ email: string }>(
        sql`SELECT email FROM "user" WHERE id = ${created.userId}`,
      );

      const { seed } = runtime.config;
      if (seed !== null) {
        await publishSeedHome(
          runtime,
          tx,
          { userId: created.userId, roleKey: SUPERADMIN_ROLE_KEY },
          seed,
        );
      }

      return {
        userId: created.userId,
        email: stored[0]?.email ?? email.toLowerCase(),
        homePublished: seed !== null,
        homePath: '/',
      };
    });
  } catch (error) {
    if (
      error instanceof BootstrapValidationError ||
      error instanceof InstallationNotEmptyError
    ) {
      throw error;
    }
    if (isDatabaseNotReady(error)) {
      throw new DatabaseNotReadyError({ cause: error });
    }
    throw error;
  }
}
