import { randomUUID } from 'node:crypto';
import {
  PermissionDeniedError,
  SUPERADMIN_ROLE_KEY,
  createAuditRecorder,
  createUserWithRole,
  type AuditActor,
  type AuditRecorder,
} from '@plakboek/auth';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { describe, expect, it } from 'vitest';
import { defineContentConfig, type ContentDeps } from '../../src/config.js';
import { createContentType } from '../../src/content-types.js';
import { createEntry } from '../../src/entries.js';
import { addField } from '../../src/fields.js';
import { saveEntry, StaleVersionError } from '../../src/save.js';
import { FieldValidationError } from '../../src/validation.js';
import { createTestDatabase } from './test-database.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const roles = defineRoles(defaultRoles);

async function readStoredData(handle: Db, entryId: string): Promise<unknown> {
  const [row] = await handle.sql<{ data: unknown }[]>`
    SELECT data FROM content_entries WHERE id = ${entryId}
  `;
  return row?.data;
}

describe('Phase 3 tracer: declare locales, create a type, attach a field, create and save an entry', () => {
  it('wires host config through type/field/entry creation and version-checked, validated, audited saves', async () => {
    const testDatabase = await createTestDatabase();
    let handle: Db | undefined;
    try {
      await runMigrations({
        connectionString: testDatabase.connectionString,
      });
      handle = createDb({ connectionString: testDatabase.connectionString });

      const resolver: PermissionResolver = createPermissionResolver(roles);
      const recorder: AuditRecorder = createAuditRecorder({
        db: handle.db,
        resolver,
      });
      const config = defineContentConfig({
        locales: ['en', 'nl'],
        defaultLocale: 'en',
        timezone: 'Europe/Brussels',
      });
      const clock = (): Date => new Date('2026-09-16T12:00:00.000Z');

      const superadminUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'owner@example.com',
        name: 'Owner',
        roleKey: SUPERADMIN_ROLE_KEY,
      });
      const editorUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'editor@example.com',
        name: 'Editor',
        roleKey: 'editor',
      });
      const superadmin: AuditActor = {
        userId: superadminUser.userId,
        roleKey: superadminUser.roleKey,
      };
      const editor: AuditActor = {
        userId: editorUser.userId,
        roleKey: editorUser.roleKey,
      };

      const deps: ContentDeps = {
        db: handle.db,
        recorder,
        resolver,
        config,
        now: clock,
      };

      const contentType = await createContentType(deps, superadmin, {
        key: 'newsArticle',
        labelSingular: '  News article ',
        labelPlural: 'News articles',
      });
      expect(contentType.slug).toBe('news-article');
      expect(contentType.labelSingular).toBe('News article');

      const field = await addField(deps, superadmin, {
        contentTypeKey: 'newsArticle',
        label: 'Title',
        fieldType: 'short_text',
        required: true,
        options: { maxLength: 120 },
      });
      expect(field.key).toBe('title');
      expect(field.widget).toBe('text-input');

      const entry = await createEntry(deps, superadmin, {
        contentTypeKey: 'newsArticle',
        locale: 'en',
        data: { title: 'Hello' },
      });
      expect(entry.status).toBe('draft');
      expect(entry.slug).toBeNull();
      expect(entry.publishedAt).toBeNull();
      expect(entry.createdAt.getTime()).toBe(entry.updatedAt.getTime());
      expect(entry.id).toMatch(UUID_PATTERN);

      const saved = await saveEntry(deps, superadmin, {
        entryId: entry.id,
        baseVersion: entry.version,
        data: { title: 'Hello, updated' },
      });
      expect(saved.version).toBe(entry.version + 1);

      const staleError: unknown = await saveEntry(deps, superadmin, {
        entryId: entry.id,
        baseVersion: entry.version,
        data: { title: 'Stale write' },
      }).catch((caught: unknown) => caught);
      expect(staleError).toBeInstanceOf(StaleVersionError);
      expect(await readStoredData(handle, entry.id)).toEqual({
        title: 'Hello, updated',
      });

      const requiredError: unknown = await saveEntry(deps, superadmin, {
        entryId: entry.id,
        baseVersion: saved.version,
        data: {},
      }).catch((caught: unknown) => caught);
      expect(requiredError).toBeInstanceOf(FieldValidationError);
      const requiredIssues = (requiredError as FieldValidationError).issues;
      expect(requiredIssues).toHaveLength(1);
      expect(requiredIssues[0]).toMatchObject({
        code: 'REQUIRED',
        fieldKey: 'title',
      });

      const unknownFieldError: unknown = await saveEntry(deps, superadmin, {
        entryId: entry.id,
        baseVersion: saved.version,
        data: { title: 'x', bogus: 1 },
      }).catch((caught: unknown) => caught);
      expect(unknownFieldError).toBeInstanceOf(FieldValidationError);
      expect(
        (unknownFieldError as FieldValidationError).issues.some(
          (issue) => issue.code === 'UNKNOWN_FIELD',
        ),
      ).toBe(true);

      const concurrentResults = await Promise.allSettled([
        saveEntry(deps, superadmin, {
          entryId: entry.id,
          baseVersion: saved.version,
          data: { title: 'Concurrent A' },
        }),
        saveEntry(deps, superadmin, {
          entryId: entry.id,
          baseVersion: saved.version,
          data: { title: 'Concurrent B' },
        }),
      ]);
      const fulfilled = concurrentResults.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = concurrentResults.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(StaleVersionError);

      const deniedError: unknown = await createContentType(deps, editor, {
        key: 'blogPost',
        labelSingular: 'Blog post',
        labelPlural: 'Blog posts',
      }).catch((caught: unknown) => caught);
      expect(deniedError).toBeInstanceOf(PermissionDeniedError);

      const auditRows = await handle.sql<
        { action: string; outcome: string; actorUserId: string | null }[]
      >`
          SELECT action, outcome, actor_user_id AS "actorUserId"
          FROM audit_log ORDER BY id
        `;
      const allowedActions = auditRows
        .filter((row) => row.outcome === 'allowed')
        .map((row) => row.action);
      expect(allowedActions).toContain('content-type.create');
      expect(allowedActions).toContain('field.add');
      expect(allowedActions).toContain('entry.create');
      expect(
        allowedActions.filter((action) => action === 'entry.save').length,
      ).toBeGreaterThanOrEqual(1);
      expect(auditRows.every((row) => row.actorUserId !== null)).toBe(true);
      const deniedRows = auditRows.filter(
        (row) =>
          row.outcome === 'denied' && row.action === 'content-type.create',
      );
      expect(deniedRows).toHaveLength(1);
    } finally {
      if (handle !== undefined) await handle.close();
      await testDatabase.drop();
    }
  });
});
