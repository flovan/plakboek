import { randomUUID } from 'node:crypto';
import {
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
import { createEntry, getEntry } from '../../src/entries.js';
import { addField } from '../../src/fields.js';
import { FieldDefinitionError } from '../../src/field-types/registry.js';
import { saveEntry } from '../../src/save.js';
import { FieldValidationError } from '../../src/validation.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('validation on save: all sixteen field types attach, store and reject on save (FIELD-02, FIELD-06)', () => {
  it('registers every field type on one content type and enforces every rule on every save', async () => {
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
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'Europe/Brussels',
      });

      const superadminUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'owner@example.com',
        name: 'Owner',
        roleKey: SUPERADMIN_ROLE_KEY,
      });
      const actor: AuditActor = {
        userId: superadminUser.userId,
        roleKey: superadminUser.roleKey,
      };

      const deps: ContentDeps = { db: handle.db, recorder, resolver, config };

      const contentType = await createContentType(deps, actor, {
        key: 'article',
        labelSingular: 'Article',
        labelPlural: 'Articles',
      });

      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'title',
        label: 'Title',
        fieldType: 'short_text',
        required: true,
        options: { maxLength: 100 },
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'body',
        label: 'Body',
        fieldType: 'long_text',
        options: { maxLength: 5 },
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'content',
        label: 'Content',
        fieldType: 'rich_text',
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'price',
        label: 'Price',
        fieldType: 'number',
        options: { min: 0 },
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'quantity',
        label: 'Quantity',
        fieldType: 'integer',
        options: { min: 0 },
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'featured',
        label: 'Featured',
        fieldType: 'boolean',
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'publishedAt',
        label: 'Published at',
        fieldType: 'date_time',
      });

      // Assert a select field defined with a widget outside its own closed
      // list (FIELD-04) is rejected -- checked before the real `category`
      // field is added under a different key.
      const categoryChoices = {
        choices: [
          { value: 'news', labels: { en: 'News' } },
          { value: 'blog', labels: { en: 'Blog' } },
        ],
      };
      await expect(
        addField(deps, actor, {
          contentTypeKey: contentType.key,
          key: 'categoryBad',
          label: 'Category (bad widget)',
          fieldType: 'select',
          options: categoryChoices,
          widget: 'color-swatch',
        }),
      ).rejects.toBeInstanceOf(FieldDefinitionError);

      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'category',
        label: 'Category',
        fieldType: 'select',
        options: categoryChoices,
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'tags',
        label: 'Tags',
        fieldType: 'multi_select',
        options: {
          choices: [
            { value: 'a', labels: { en: 'A' } },
            { value: 'b', labels: { en: 'B' } },
          ],
        },
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'cover',
        label: 'Cover',
        fieldType: 'image',
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'attachment',
        label: 'Attachment',
        fieldType: 'file',
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'related',
        label: 'Related',
        fieldType: 'reference',
        options: { allowedTypeKeys: ['article'], cardinality: 'single' },
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'meta',
        label: 'Meta',
        fieldType: 'json',
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'anchor',
        label: 'Anchor',
        fieldType: 'slug',
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'website',
        label: 'Website',
        fieldType: 'url',
      });
      await addField(deps, actor, {
        contentTypeKey: contentType.key,
        key: 'items',
        label: 'Items',
        fieldType: 'repeater',
        options: {
          fields: [
            {
              key: 'label',
              label: 'Label',
              fieldType: 'short_text',
              required: true,
            },
          ],
        },
      });

      const relatedId = randomUUID();
      const validData = {
        title: 'Hello world',
        body: 'a\nb',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] },
          ],
        },
        price: 9.99,
        quantity: 3,
        featured: true,
        publishedAt: '2026-09-16T10:00:00+02:00',
        category: 'news',
        tags: ['a', 'b'],
        cover: 'asset_01H9',
        attachment: 'asset_01FILE',
        related: relatedId,
        meta: { a: 1 },
        anchor: 'my-anchor',
        website: 'https://example.com',
        items: [{ label: 'Item 1' }],
      };

      const entry = await createEntry(deps, actor, {
        contentTypeKey: contentType.key,
        locale: 'en',
        data: validData,
      });
      expect(entry.status).toBe('draft');

      const stored = await getEntry(deps.db, entry.id);
      expect(stored?.data.publishedAt).toBe('2026-09-16T08:00:00.000Z');
      expect(stored?.data.category).toBe('news');
      expect(stored?.data.tags).toEqual(['a', 'b']);
      expect(stored?.data.items).toEqual([{ label: 'Item 1' }]);

      const invalidData = {
        title: 123,
        body: 'a'.repeat(10),
        content: 'html string',
        price: 'not-a-number',
        quantity: 1.5,
        featured: 'not-a-boolean',
        publishedAt: 'not-a-date',
        category: 'not-a-choice',
        tags: 'not-an-array',
        cover: 'bad id!',
        attachment: 'bad id!',
        related: 'not-a-uuid',
        meta: { a: 'x'.repeat(70000) },
        anchor: 'BAD SLUG',
        website: 'javascript:alert(1)',
        items: 'not-an-array',
      };

      const invalidError: unknown = await saveEntry(deps, actor, {
        entryId: entry.id,
        baseVersion: entry.version,
        data: invalidData,
      }).catch((caught: unknown) => caught);
      expect(invalidError).toBeInstanceOf(FieldValidationError);
      const invalidIssues = (invalidError as FieldValidationError).issues;
      const invalidKeys = new Set(invalidIssues.map((issue) => issue.fieldKey));
      for (const key of Object.keys(validData)) {
        expect(invalidKeys.has(key)).toBe(true);
      }

      const afterInvalidSave = await getEntry(deps.db, entry.id);
      expect(afterInvalidSave?.version).toBe(entry.version);
      expect(afterInvalidSave?.data).toEqual(stored?.data);

      // A draft save with the required field emptied is refused (D-12).
      const requiredError: unknown = await saveEntry(deps, actor, {
        entryId: entry.id,
        baseVersion: entry.version,
        data: {},
      }).catch((caught: unknown) => caught);
      expect(requiredError).toBeInstanceOf(FieldValidationError);
      const requiredIssues = (requiredError as FieldValidationError).issues;
      expect(
        requiredIssues.some(
          (issue) => issue.fieldKey === 'title' && issue.code === 'REQUIRED',
        ),
      ).toBe(true);

      const finalEntry = await getEntry(deps.db, entry.id);
      expect(finalEntry?.status).toBe('draft');
      expect(finalEntry?.version).toBe(entry.version);
    } finally {
      if (handle !== undefined) await handle.close();
      await testDatabase.drop();
    }
  });
});
