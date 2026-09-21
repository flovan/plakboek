import { randomUUID } from 'node:crypto';
import {
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContentConfig, type ContentDeps } from '../../src/config.js';
import { createContentType, setTitleField } from '../../src/content-types.js';
import { createEntry } from '../../src/entries.js';
import {
  addField,
  computeAddFieldImpact,
  computeFieldDeleteImpact,
  computeFieldKeyUsage,
  computeFieldUpdateImpact,
  deleteField,
  duplicateField,
  FieldTypeImmutableError,
  listFields,
  renameField,
  updateField,
  type UpdateFieldInput,
} from '../../src/fields.js';
import { FieldDefinitionError } from '../../src/field-types/registry.js';
import { saveEntry, StaleVersionError } from '../../src/save.js';
import { FieldValidationError } from '../../src/validation.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

// A regressed guard would compile the catastrophic regular expression
// against `'a'.repeat(30)` and hang the event loop for roughly five seconds
// (doubling per added character past the guard's own measured ~150ms/28-char
// baseline) rather than failing fast -- so the budget is generous while
// still catching a real regression well before it could be mistaken for a
// slow CI runner.
const STORED_PATTERN_BUDGET_MS = 2000;

const roles = defineRoles(defaultRoles);

describe('Field update, rename, duplicate, delete and required-field impact (FIELD-06 concurrency, D-07, D-08, D-09, D-18)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;
  let superadmin: AuditActor;

  const clock = (): Date => new Date('2026-09-16T12:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    resolver = createPermissionResolver(roles);
    recorder = createAuditRecorder({ db: handle.db, resolver });

    const config = defineContentConfig({
      locales: ['en', 'nl'],
      defaultLocale: 'en',
      timezone: 'Europe/Brussels',
    });

    deps = { db: handle.db, recorder, resolver, config, now: clock };

    const created = await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: 'superadmin',
    });
    superadmin = { userId: created.userId, roleKey: created.roleKey };
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  async function readEntryData(
    entryId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await handle.sql<{ data: Record<string, unknown> }[]>`
      SELECT data FROM content_entries WHERE id = ${entryId}
    `;
    return rows[0]?.data ?? {};
  }

  async function readEntryVersion(entryId: string): Promise<number> {
    const rows = await handle.sql<{ version: number }[]>`
      SELECT version FROM content_entries WHERE id = ${entryId}
    `;
    return rows[0]?.version ?? -1;
  }

  it('addField required with a default backfills every entry, bumping versions; computeAddFieldImpact reports entriesToBackfill beforehand', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsBackfill',
      labelSingular: 'Fields backfill',
      labelPlural: 'Fields backfill',
    });
    const entries = await Promise.all(
      Array.from({ length: 3 }, () =>
        createEntry(deps, superadmin, {
          contentTypeKey: type.key,
          locale: 'en',
        }),
      ),
    );

    const impact = await computeAddFieldImpact(handle.db, {
      contentTypeKey: type.key,
      required: true,
      defaultValue: 'n/a',
    });
    expect(impact.entryCount).toBe(3);
    expect(impact.entriesToBackfill).toBe(3);
    expect(impact.entriesBlockedUntilFilled).toBe(0);

    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Summary',
      fieldType: 'short_text',
      required: true,
      defaultValue: 'n/a',
    });

    for (const entry of entries) {
      const data = await readEntryData(entry.id);
      expect(data.summary).toBe('n/a');
      expect(await readEntryVersion(entry.id)).toBe(entry.version + 1);
    }
  });

  it('addField required without a default changes no entry; the next save without the key fails REQUIRED; computeAddFieldImpact reports entriesBlockedUntilFilled beforehand', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsBlock',
      labelSingular: 'Fields block',
      labelPlural: 'Fields block',
    });
    const entries = await Promise.all(
      Array.from({ length: 3 }, () =>
        createEntry(deps, superadmin, {
          contentTypeKey: type.key,
          locale: 'en',
        }),
      ),
    );

    const impact = await computeAddFieldImpact(handle.db, {
      contentTypeKey: type.key,
      required: true,
    });
    expect(impact.entriesToBackfill).toBe(0);
    expect(impact.entriesBlockedUntilFilled).toBe(3);

    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Note',
      fieldType: 'short_text',
      required: true,
    });

    const firstEntry = entries[0];
    expect(firstEntry).toBeDefined();
    if (firstEntry === undefined) throw new Error('unreachable');
    expect(await readEntryData(firstEntry.id)).toEqual({});

    const error: unknown = await saveEntry(deps, superadmin, {
      entryId: firstEntry.id,
      baseVersion: firstEntry.version,
      data: {},
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FieldValidationError);
    expect(
      (error as FieldValidationError).issues.some(
        (issue) => issue.code === 'REQUIRED' && issue.fieldKey === 'note',
      ),
    ).toBe(true);
  });

  it('updateField making an optional field required applies the same backfill rule', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsUpdateRequired',
      labelSingular: 'Fields update required',
      labelPlural: 'Fields update required',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Note',
      fieldType: 'short_text',
    });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
    });

    await updateField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'note',
      required: true,
      defaultValue: 'filled',
    });

    expect(await readEntryData(entry.id)).toEqual({ note: 'filled' });
    expect(await readEntryVersion(entry.id)).toBe(entry.version + 1);
  });

  it('updateField rejects any input carrying a fieldType property with FieldTypeImmutableError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsImmutable',
      labelSingular: 'Fields immutable',
      labelPlural: 'Fields immutable',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Note',
      fieldType: 'short_text',
    });

    const maliciousInput = {
      contentTypeKey: type.key,
      fieldKey: 'note',
      fieldType: 'integer',
    } as unknown as UpdateFieldInput;

    const error: unknown = await updateField(
      deps,
      superadmin,
      maliciousInput,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FieldTypeImmutableError);
  });

  it('updateField lowering maxLength below a stored value succeeds; computeFieldUpdateImpact counts the failing entry beforehand', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsLowerMaxLength',
      labelSingular: 'Fields lower max length',
      labelPlural: 'Fields lower max length',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Bio',
      fieldType: 'short_text',
      options: { maxLength: 200 },
    });
    const longValue = 'x'.repeat(50);
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { bio: longValue },
    });

    const impact = await computeFieldUpdateImpact(handle.db, {
      contentTypeKey: type.key,
      fieldKey: 'bio',
      options: { maxLength: 10 },
    });
    expect(impact.entriesFailingNewRules).toBe(1);

    const updated = await updateField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'bio',
      options: { maxLength: 10 },
    });
    expect((updated.options as { maxLength: number }).maxLength).toBe(10);
    expect((await readEntryData(entry.id)).bio).toBe(longValue);
  });

  it('renameField moves the value in every entry, leaves no old key, records history and moves the title field designation; a stale save after rename fails', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsRename',
      labelSingular: 'Fields rename',
      labelPlural: 'Fields rename',
      routable: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Title',
      fieldType: 'short_text',
    });
    await setTitleField(deps, superadmin, { key: type.key, fieldKey: 'title' });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { title: 'Hello' },
    });

    const usage = await computeFieldKeyUsage(handle.db, {
      contentTypeKey: type.key,
      fieldKey: 'title',
    });
    expect(usage.entriesHoldingValue).toBe(1);
    expect(usage.suggestDuplicate).toBe(true);

    await renameField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'title',
      newKey: 'headline',
    });

    const data = await readEntryData(entry.id);
    expect(data.headline).toBe('Hello');
    expect(data.title).toBeUndefined();
    expect(await readEntryVersion(entry.id)).toBe(entry.version + 1);

    const historyRows = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_field_key_history WHERE content_type_id = ${type.id}
    `;
    expect(Number(historyRows[0]?.count)).toBe(1);

    const fields = await listFields(handle.db, type.id);
    expect(fields.some((field) => field.key === 'headline')).toBe(true);

    const typeRows = await handle.sql<{ title_field_key: string | null }[]>`
      SELECT title_field_key FROM content_types WHERE id = ${type.id}
    `;
    expect(typeRows[0]?.title_field_key).toBe('headline');

    const staleError: unknown = await saveEntry(deps, superadmin, {
      entryId: entry.id,
      baseVersion: entry.version,
      data: { title: 'x' },
    }).catch((caught: unknown) => caught);
    expect(staleError).toBeInstanceOf(StaleVersionError);
  });

  it('duplicateField copies definition and values by default, and definition only when copyValues is false', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsDuplicate',
      labelSingular: 'Fields duplicate',
      labelPlural: 'Fields duplicate',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Title',
      fieldType: 'short_text',
    });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { title: 'Hello' },
    });

    const duplicated = await duplicateField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'title',
    });
    expect(duplicated.key).toBe('titleCopy');
    const dataAfterCopy = await readEntryData(entry.id);
    expect(dataAfterCopy.title).toBe('Hello');
    expect(dataAfterCopy.titleCopy).toBe('Hello');

    const duplicatedNoCopy = await duplicateField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'title',
      newKey: 'titleNoCopy',
      copyValues: false,
    });
    expect(duplicatedNoCopy.key).toBe('titleNoCopy');
    const dataAfterNoCopy = await readEntryData(entry.id);
    expect(dataAfterNoCopy.titleNoCopy).toBeUndefined();
  });

  it('deleteField removes the key from every entry and the field row; computeFieldDeleteImpact reports entriesHoldingValue and clearsTitleField beforehand', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsDelete',
      labelSingular: 'Fields delete',
      labelPlural: 'Fields delete',
      routable: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Title',
      fieldType: 'short_text',
    });
    await setTitleField(deps, superadmin, { key: type.key, fieldKey: 'title' });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { title: 'Hello' },
    });

    const impact = await computeFieldDeleteImpact(handle.db, {
      contentTypeKey: type.key,
      fieldKey: 'title',
    });
    expect(impact.entriesHoldingValue).toBe(1);
    expect(impact.clearsTitleField).toBe(true);

    await deleteField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'title',
    });

    expect(await readEntryData(entry.id)).toEqual({});
    const fields = await listFields(handle.db, type.id);
    expect(fields.some((field) => field.key === 'title')).toBe(false);

    const typeRows = await handle.sql<{ title_field_key: string | null }[]>`
      SELECT title_field_key FROM content_types WHERE id = ${type.id}
    `;
    expect(typeRows[0]?.title_field_key).toBeNull();
  });

  it('a repeater updateField removing a sub-field strips it from every stored item; computeFieldUpdateImpact counts affected items beforehand', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsRepeater',
      labelSingular: 'Fields repeater',
      labelPlural: 'Fields repeater',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Team',
      fieldType: 'repeater',
      options: {
        fields: [
          { key: 'name', label: 'Name', fieldType: 'short_text' },
          { key: 'bio', label: 'Bio', fieldType: 'short_text' },
        ],
      },
    });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {
        team: [{ name: 'A', bio: 'bio-a' }, { name: 'B' }],
      },
    });

    const impact = await computeFieldUpdateImpact(handle.db, {
      contentTypeKey: type.key,
      fieldKey: 'team',
      options: {
        fields: [{ key: 'name', label: 'Name', fieldType: 'short_text' }],
      },
    });
    expect(impact.repeaterItemsLosingValues).toBe(1);

    await updateField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'team',
      options: {
        fields: [{ key: 'name', label: 'Name', fieldType: 'short_text' }],
      },
    });

    const data = await readEntryData(entry.id);
    const team = data.team as { name: string; bio?: string }[];
    expect(team.every((item) => !Object.hasOwn(item, 'bio'))).toBe(true);
    expect(team[0]?.name).toBe('A');
    expect(team[1]?.name).toBe('B');
  });

  it('a deleteField and a saveEntry on the same type started concurrently never leave a row holding the deleted key', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'fieldsConcurrency',
      labelSingular: 'Fields concurrency',
      labelPlural: 'Fields concurrency',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Note',
      fieldType: 'short_text',
    });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { note: 'x' },
    });

    const results = await Promise.allSettled([
      deleteField(deps, superadmin, {
        contentTypeKey: type.key,
        fieldKey: 'note',
      }),
      saveEntry(deps, superadmin, {
        entryId: entry.id,
        baseVersion: entry.version,
        data: { note: 'y' },
      }),
    ]);

    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);

    const fields = await listFields(handle.db, type.id);
    const fieldStillExists = fields.some((field) => field.key === 'note');
    const data = await readEntryData(entry.id);

    expect(fieldStillExists || data.note === undefined).toBe(true);
  });

  it('addField refuses an unsafe pattern at define time, rolling back with no row written (FIELD-06 ReDoS mitigation)', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'redosGuardAdd',
      labelSingular: 'ReDoS guard add',
      labelPlural: 'ReDoS guard add',
    });

    const error: unknown = await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Code',
      fieldType: 'short_text',
      options: { pattern: '(a|a)*' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FieldDefinitionError);

    const fields = await listFields(handle.db, type.id);
    expect(fields.some((field) => field.key === 'code')).toBe(false);
  });

  it('addField accepts a disjoint alternation pattern end to end: a matching value saves, a non-matching one is refused', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'redosGuardSafe',
      labelSingular: 'ReDoS guard safe',
      labelPlural: 'ReDoS guard safe',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Code',
      fieldType: 'short_text',
      options: { pattern: '^(cat|dog)$' },
    });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { code: 'cat' },
    });
    expect((await readEntryData(entry.id)).code).toBe('cat');

    const error: unknown = await saveEntry(deps, superadmin, {
      entryId: entry.id,
      baseVersion: entry.version,
      data: { code: 'fox' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FieldValidationError);
    expect(
      (error as FieldValidationError).issues.some(
        (issue) => issue.code === 'INVALID_VALUE' && issue.fieldKey === 'code',
      ),
    ).toBe(true);
  });

  it('computeFieldUpdateImpact refuses an unsafe pattern change, leaving the stored options unchanged', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'redosGuardUpdate',
      labelSingular: 'ReDoS guard update',
      labelPlural: 'ReDoS guard update',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Code',
      fieldType: 'short_text',
      options: { pattern: '^(cat|dog)$' },
    });

    const error: unknown = await computeFieldUpdateImpact(handle.db, {
      contentTypeKey: type.key,
      fieldKey: 'code',
      options: { pattern: '(a|aa)+' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FieldDefinitionError);

    const fields = await listFields(handle.db, type.id);
    expect(
      fields.find((field) => field.key === 'code')?.options as {
        pattern?: string;
      },
    ).toEqual({ pattern: '^(cat|dog)$' });
  });

  it('a pattern stored before the guard tightened fails the next save with FieldDefinitionError in bounded time, never hanging on a compiled catastrophic regex', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'redosGuardStored',
      labelSingular: 'ReDoS guard stored',
      labelPlural: 'ReDoS guard stored',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Code',
      fieldType: 'short_text',
      options: { pattern: '^(cat|dog)$' },
    });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { code: 'cat' },
    });
    const fields = await listFields(handle.db, type.id);
    const fieldId = fields.find((field) => field.key === 'code')?.id ?? '';

    // Simulates a pattern stored while the guard was defective (03-VERIFICATION.md's
    // gap): write it directly, bypassing addField/updateField entirely.
    await handle.sql`UPDATE content_type_fields SET options = ${JSON.stringify({
      pattern: '(a|a)*b',
    })}::jsonb WHERE id = ${fieldId}`;

    let caught: unknown;
    const start = performance.now();
    try {
      await saveEntry(deps, superadmin, {
        entryId: entry.id,
        baseVersion: entry.version,
        data: { code: 'a'.repeat(30) },
      });
    } catch (error: unknown) {
      caught = error;
    }
    const elapsedMs = performance.now() - start;

    expect(caught).toBeInstanceOf(FieldDefinitionError);
    expect((caught as FieldDefinitionError).message).toContain('pattern');
    expect(elapsedMs).toBeLessThan(STORED_PATTERN_BUDGET_MS);

    // Restore the safe pattern so the fixture is left usable and the
    // assertion above is about the pattern, not a permanently broken row.
    await handle.sql`UPDATE content_type_fields SET options = ${JSON.stringify({
      pattern: '^(cat|dog)$',
    })}::jsonb WHERE id = ${fieldId}`;

    const restored = await saveEntry(deps, superadmin, {
      entryId: entry.id,
      baseVersion: entry.version,
      data: { code: 'dog' },
    });
    expect((await readEntryData(restored.id)).code).toBe('dog');
  });
});
