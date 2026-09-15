/**
 * Drizzle table definitions for the better-auth core tables plus the audit
 * log. TypeScript properties are camelCase (what better-auth and its drizzle
 * adapter address), Postgres columns are snake_case.
 *
 * The SQL that creates these tables ships as `@plakboek/db`'s migration
 * `0001_auth_core`. Migrations are forward-only and checksum-immutable, so a
 * change here is never an edit to that migration: it is a new, higher-
 * numbered migration plus the matching change in this file.
 *
 * Table names follow better-auth's singular defaults. `user` is a reserved
 * word in Postgres, so every hand-written statement must quote it as
 * `"user"`; Drizzle quotes identifiers itself.
 */
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamptz('created_at').notNull(),
  updatedAt: timestamptz('updated_at').notNull(),
  // One column for the user's role: the property is `role` because
  // better-auth's admin plugin reads that field, the column is `role_key`
  // because the value is a plain role key checked against the host's code
  // role map by @plakboek/permissions -- never a foreign key to a table.
  role: text('role_key'),
  banned: boolean('banned'),
  banReason: text('ban_reason'),
  banExpires: timestamptz('ban_expires'),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamptz('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const twoFactor = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // better-auth's twoFactor plugin records whether a TOTP enrolment has
    // been confirmed; rows it writes without the flag count as verified.
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count')
      .notNull()
      .default(0),
    lockedUntil: timestamptz('locked_until'),
  },
  (table) => [
    index('two_factor_user_id_idx').on(table.userId),
    index('two_factor_secret_idx').on(table.secret),
  ],
);

/**
 * One row per permission-gated mutation attempt (USER-08, D-05, D-06).
 * Append-only: this module defines no update or delete helper, and the
 * scheduled prune is the only statement that ever deletes from it. `id` is a
 * sequence, so rows written inside one transaction read back in write order
 * regardless of `created_at`. `before`/`after` hold whole entity states (SQL
 * NULL where not applicable), not a computed delta.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: text('actor_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    actorRoleKey: text('actor_role_key').notNull(),
    impersonatorUserId: text('impersonator_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    permission: text('permission').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    outcome: text('outcome').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_actor_idx').on(table.actorUserId, table.id),
    index('audit_log_created_at_idx').on(table.createdAt),
  ],
);
