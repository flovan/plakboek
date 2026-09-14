import type { Migration } from '../migrate.js';

/**
 * The first shipped schema: better-auth's core tables (`user`, `session`,
 * `account`, `verification`, `two_factor`) and the append-only `audit_log`.
 * Mirrors the Drizzle definitions in `@plakboek/auth`'s `src/schema.ts`.
 *
 * `user` is a reserved word in Postgres and is quoted everywhere. The user's
 * role is one plain-string column, `role_key`, checked against the host's
 * code role map at request time -- there is no roles table. `audit_log.id`
 * is a sequence so audit rows read back in write order.
 *
 * Immutable once shipped (checksum-enforced): corrections are a new,
 * higher-numbered migration, never an edit to this string.
 */
export const migration: Migration = {
  name: '0001_auth_core',
  transactional: true,
  sql: `
CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "role_key" text,
  "banned" boolean,
  "ban_reason" text,
  "ban_expires" timestamp with time zone,
  "two_factor_enabled" boolean DEFAULT false NOT NULL,
  CONSTRAINT "user_email_unique" UNIQUE ("email")
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "token" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL,
  "impersonated_by" text,
  CONSTRAINT "session_token_unique" UNIQUE ("token"),
  CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "password" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "two_factor" (
  "id" text PRIMARY KEY NOT NULL,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "user_id" text NOT NULL,
  "verified" boolean DEFAULT true,
  "failed_verification_count" integer DEFAULT 0 NOT NULL,
  "locked_until" timestamp with time zone,
  CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "actor_user_id" text,
  "actor_role_key" text NOT NULL,
  "impersonator_user_id" text,
  "permission" text NOT NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "outcome" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "audit_log_impersonator_user_id_user_id_fk"
    FOREIGN KEY ("impersonator_user_id")
    REFERENCES "user" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "session_user_id_idx"
  ON "session" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "account_user_id_idx"
  ON "account" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx"
  ON "verification" USING btree ("identifier");
CREATE INDEX IF NOT EXISTS "two_factor_user_id_idx"
  ON "two_factor" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "two_factor_secret_idx"
  ON "two_factor" USING btree ("secret");
CREATE INDEX IF NOT EXISTS "audit_log_actor_idx"
  ON "audit_log" USING btree ("actor_user_id", "id");
CREATE INDEX IF NOT EXISTS "audit_log_created_at_idx"
  ON "audit_log" USING btree ("created_at");
`,
};
