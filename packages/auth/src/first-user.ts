/**
 * The first-user-is-superadmin rule (AUTH-01, D-14). Whatever creates a
 * user -- the bootstrap wizard, a seed script, an invite -- goes through
 * `createUserWithRole`, and the very first user row an installation ever
 * gets holds `superadmin` no matter which role its caller asked for. There
 * is no separate "has this install been bootstrapped" flag to track.
 *
 * Because every path goes through it, `createUserWithRole` is also where an
 * address gets its stored form: trimmed and lower-cased. Addresses are
 * looked up in that form, so a user stored any other way could not be found
 * and could be created a second time.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { account, user } from './schema.js';

/** The reserved role key `@plakboek/permissions` requires every role map to
 * define with every permission in the catalogue. */
export const SUPERADMIN_ROLE_KEY = 'superadmin';

/**
 * Transaction-scoped advisory-lock key reserved for @plakboek/auth's
 * first-user creation. Postgres advisory locks share one namespace per
 * database, so this must differ from every other key used against a
 * Plakboek database -- in particular `@plakboek/db`'s migration lock key.
 */
export const FIRST_USER_LOCK_KEY = '7305528140966231745';

/** better-auth's provider id for email-and-password credentials. */
const CREDENTIAL_PROVIDER_ID = 'credential';

/**
 * The form an address is stored and looked up in: trimmed and lower-cased.
 * Anything that is not a string becomes the empty string, which no stored
 * user has. Internal to the package; lookups elsewhere use the same rule.
 */
export function storedEmailForm(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** Any Drizzle Postgres handle that can open a transaction: the database
 * itself, or an enclosing transaction (which nests as a savepoint). */
export type UserCreationExecutor = PgDatabase<PgQueryResultHKT>;

export type CreateUserInput = {
  readonly id: string;
  /** Stored trimmed and lower-cased. Must not be empty once trimmed. */
  readonly email: string;
  readonly name: string;
  readonly roleKey: string;
  /** A hash produced by better-auth's password hasher. When present, an
   * email-and-password credential account is created alongside the user. */
  readonly passwordHash?: string;
};

export type CreateUserResult = {
  readonly userId: string;
  readonly roleKey: string;
  readonly wasFirstUser: boolean;
};

export type CreateUserOptions = {
  readonly now?: () => Date;
};

/**
 * Creates one user, forcing `role_key` to `superadmin` when the user table
 * is empty and otherwise storing the caller's `roleKey`.
 *
 * The existence check and the insert run in one transaction that first
 * takes a transaction-scoped advisory lock, so two concurrent first-user
 * creations serialize: the second waits until the first commits and then
 * sees a row. Reading "zero users" in one statement and inserting in
 * another without that lock is exactly the race that would mint two
 * superadmins. The lock releases on COMMIT or ROLLBACK by itself.
 *
 * The address is stored trimmed and lower-cased, so `' Ada@Example.TEST '`
 * becomes `ada@example.test`, and a later creation for that address in any
 * case hits the unique constraint instead of adding a second row. An
 * address that is empty once trimmed throws `TypeError` before any
 * statement runs.
 */
export async function createUserWithRole(
  db: UserCreationExecutor,
  input: CreateUserInput,
  options?: CreateUserOptions,
): Promise<CreateUserResult> {
  const email = storedEmailForm(input.email);
  if (email.length === 0) {
    throw new TypeError(
      '@plakboek/auth: a user needs an email address that is not blank',
    );
  }
  const now = options?.now ?? (() => new Date());

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${FIRST_USER_LOCK_KEY}::bigint)`,
    );

    const [{ userExists } = { userExists: false }] = await tx
      .select({ userExists: sql<boolean>`EXISTS (SELECT 1 FROM "user")` })
      .from(sql`(SELECT 1) AS "probe"`);
    const wasFirstUser = !userExists;
    const roleKey = wasFirstUser ? SUPERADMIN_ROLE_KEY : input.roleKey;
    const createdAt = now();

    await tx.insert(user).values({
      id: input.id,
      email,
      name: input.name,
      role: roleKey,
      createdAt,
      updatedAt: createdAt,
    });

    if (input.passwordHash !== undefined) {
      await tx.insert(account).values({
        id: randomUUID(),
        accountId: input.id,
        providerId: CREDENTIAL_PROVIDER_ID,
        userId: input.id,
        password: input.passwordHash,
        createdAt,
        updatedAt: createdAt,
      });
    }

    return { userId: input.id, roleKey, wasFirstUser };
  });
}
