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
import { createContentType } from '../../src/content-types.js';
import { createEntry, getEntry } from '../../src/entries.js';
import { addField } from '../../src/fields.js';
import { deleteEntryPermanently } from '../../src/lifecycle.js';
import { publishEntry } from '../../src/publish.js';
import {
  ReferenceTargetMissingError,
  ReferenceTypeNotAllowedError,
} from '../../src/references.js';
import { saveEntry } from '../../src/save.js';
import { trashEntry } from '../../src/lifecycle.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

type IndexRow = {
  readonly fieldId: string;
  readonly targetTranslationGroup: string;
};

describe('Reference resolution on save and the reverse index (D-38, D-39, D-40, T-03-61)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;
  let editor: AuditActor;
  let superadmin: AuditActor;

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

    deps = { db: handle.db, recorder, resolver, config };

    async function makeUser(
      email: string,
      roleKey: string,
    ): Promise<AuditActor> {
      const created = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email,
        name: email,
        roleKey,
      });
      return { userId: created.userId, roleKey: created.roleKey };
    }

    superadmin = await makeUser('references-owner@example.com', 'superadmin');
    editor = await makeUser('references-editor@example.com', 'editor');
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  async function indexRows(sourceEntryId: string): Promise<IndexRow[]> {
    return await handle.sql<IndexRow[]>`
      SELECT field_id AS "fieldId",
        target_translation_group AS "targetTranslationGroup"
      FROM content_entry_references
      WHERE source_entry_id = ${sourceEntryId}
      ORDER BY target_translation_group
    `;
  }

  let typeCounter = 0;
  function uniqueKey(prefix: string): string {
    typeCounter += 1;
    return `${prefix}${typeCounter}`;
  }

  async function makeTargetType(prefix: string) {
    const key = uniqueKey(prefix);
    return await createContentType(deps, superadmin, {
      key,
      labelSingular: key,
      labelPlural: key,
    });
  }

  async function makeReferencingType(
    prefix: string,
    allowedTypeKeys: readonly string[],
    cardinality: 'single' | 'multiple' = 'single',
    options: { readonly drafts?: boolean; readonly revisions?: boolean } = {},
  ) {
    const key = uniqueKey(prefix);
    const type = await createContentType(deps, superadmin, {
      key,
      labelSingular: key,
      labelPlural: key,
      drafts: options.drafts ?? false,
      revisions: options.revisions ?? false,
      ...(options.revisions === true ? { revisionMode: 'on_publish' } : {}),
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'related',
      label: 'Related',
      fieldType: 'reference',
      options: { allowedTypeKeys, cardinality },
    });
    return type;
  }

  it('saving a single reference naming an existing entrys translation group succeeds and writes exactly one row', async () => {
    const targetType = await makeTargetType('refTargetSingle');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });

    const sourceType = await makeReferencingType('refSourceSingle', [
      targetType.key,
    ]);
    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });

    const saved = await saveEntry(deps, editor, {
      entryId: source.id,
      baseVersion: source.version,
      data: { related: target.translationGroup },
    });

    expect(saved.data.related).toBe(target.translationGroup);
    const rows = await indexRows(saved.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetTranslationGroup).toBe(target.translationGroup);
  });

  it('saving a reference naming a UUID no entry holds throws ReferenceTargetMissingError; nothing is written and the version does not move', async () => {
    const sourceType = await makeReferencingType('refMissingTarget', [
      'refMissingTargetTypeThatDoesNotExist',
    ]);
    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });

    const missingGroup = randomUUID();
    const error: unknown = await saveEntry(deps, editor, {
      entryId: source.id,
      baseVersion: source.version,
      data: { related: missingGroup },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReferenceTargetMissingError);
    expect(error).toMatchObject({
      fieldKey: 'related',
      targetTranslationGroup: missingGroup,
    });

    const unchanged = await getEntry(deps.db, source.id);
    expect(unchanged?.version).toBe(source.version);
    expect(unchanged?.data.related).toBeUndefined();
    const rows = await indexRows(source.id);
    expect(rows).toHaveLength(0);
  });

  it("saving a reference whose target's content type is not in allowedTypeKeys throws ReferenceTypeNotAllowedError naming the field, target and actual type", async () => {
    const targetType = await makeTargetType('refDisallowedTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });

    const otherAllowedType = await makeTargetType('refOtherAllowedType');
    const sourceType = await makeReferencingType('refDisallowedSource', [
      otherAllowedType.key,
    ]);
    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });

    const error: unknown = await saveEntry(deps, editor, {
      entryId: source.id,
      baseVersion: source.version,
      data: { related: target.translationGroup },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReferenceTypeNotAllowedError);
    expect(error).toMatchObject({
      fieldKey: 'related',
      targetTranslationGroup: target.translationGroup,
      actualTypeKey: targetType.key,
      allowedTypeKeys: [otherAllowedType.key],
    });
  });

  it('D-39: a target that exists only in nl satisfies a reference saved from an en entry, because the value is the translation group', async () => {
    const targetType = await makeTargetType('refNlOnlyTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'nl',
      data: {},
    });

    const sourceType = await makeReferencingType('refFromEnSource', [
      targetType.key,
    ]);
    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });

    const saved = await saveEntry(deps, editor, {
      entryId: source.id,
      baseVersion: source.version,
      data: { related: target.translationGroup },
    });
    expect(saved.data.related).toBe(target.translationGroup);
  });

  it('D-40: a reference to a trashed target saves, publishes and re-saves without error, and the index row is kept', async () => {
    const targetType = await makeTargetType('refTrashedTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });
    const trashedTarget = await trashEntry(deps, editor, {
      entryId: target.id,
      baseVersion: target.version,
    });
    expect(trashedTarget.status).toBe('trashed');

    const sourceType = await makeReferencingType('refToTrashedSource', [
      targetType.key,
    ]);
    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });

    const saved = await saveEntry(deps, editor, {
      entryId: source.id,
      baseVersion: source.version,
      data: { related: target.translationGroup },
    });
    expect(saved.data.related).toBe(target.translationGroup);

    const published = await publishEntry(deps, editor, {
      entryId: saved.id,
      baseVersion: saved.version,
    });
    expect(published.data.related).toBe(target.translationGroup);

    const resaved = await saveEntry(deps, editor, {
      entryId: published.id,
      baseVersion: published.version,
      data: { related: target.translationGroup },
    });
    expect(resaved.data.related).toBe(target.translationGroup);

    const rows = await indexRows(source.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetTranslationGroup).toBe(target.translationGroup);
  });

  it('a multiple reference holding three targets writes three rows; removing one leaves two; an empty list leaves none', async () => {
    const targetType = await makeTargetType('refMultiTarget');
    const targets = await Promise.all(
      [0, 1, 2].map(() =>
        createEntry(deps, editor, {
          contentTypeKey: targetType.key,
          locale: 'en',
          data: {},
        }),
      ),
    );

    const sourceType = await makeReferencingType(
      'refMultiSource',
      [targetType.key],
      'multiple',
    );
    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });

    const groups = targets.map((target) => target.translationGroup);
    const saved = await saveEntry(deps, editor, {
      entryId: source.id,
      baseVersion: source.version,
      data: { related: groups },
    });
    expect(await indexRows(source.id)).toHaveLength(3);

    const [firstGroup, ...restGroups] = groups;
    expect(firstGroup).toBeDefined();
    const resaved = await saveEntry(deps, editor, {
      entryId: saved.id,
      baseVersion: saved.version,
      data: { related: restGroups },
    });
    const remaining = await indexRows(source.id);
    expect(remaining).toHaveLength(2);
    expect(
      remaining.some((row) => row.targetTranslationGroup === firstGroup),
    ).toBe(false);

    await saveEntry(deps, editor, {
      entryId: resaved.id,
      baseVersion: resaved.version,
      data: { related: [] },
    });
    expect(await indexRows(source.id)).toHaveLength(0);
  });

  it('a reference held in a repeater sub-field is checked and indexed like a top-level one, and removing the repeater item removes its row', async () => {
    const targetType = await makeTargetType('refRepeaterTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });

    const sourceType = await createContentType(deps, superadmin, {
      key: uniqueKey('refRepeaterSource'),
      labelSingular: 'refRepeaterSource',
      labelPlural: 'refRepeaterSource',
    });
    await addField(deps, superadmin, {
      contentTypeKey: sourceType.key,
      key: 'items',
      label: 'Items',
      fieldType: 'repeater',
      options: {
        fields: [
          {
            key: 'author',
            label: 'Author',
            fieldType: 'reference',
            options: {
              allowedTypeKeys: [targetType.key],
              cardinality: 'single',
            },
          },
        ],
      },
    });

    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });

    const saved = await saveEntry(deps, editor, {
      entryId: source.id,
      baseVersion: source.version,
      data: { items: [{ author: target.translationGroup }] },
    });
    const rows = await indexRows(source.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetTranslationGroup).toBe(target.translationGroup);

    await saveEntry(deps, editor, {
      entryId: saved.id,
      baseVersion: saved.version,
      data: { items: [] },
    });
    expect(await indexRows(source.id)).toHaveLength(0);
  });

  it('drafts on, published: a save that adds a reference stages it in the pending revision and writes no index row; publishing it writes the row', async () => {
    const targetType = await makeTargetType('refDraftTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });

    const sourceType = await makeReferencingType(
      'refDraftSource',
      [targetType.key],
      'single',
      { drafts: true },
    );
    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });
    const published = await publishEntry(deps, editor, {
      entryId: source.id,
      baseVersion: source.version,
    });

    const staged = await saveEntry(deps, editor, {
      entryId: published.id,
      baseVersion: published.version,
      data: { related: target.translationGroup },
    });
    expect(staged.draftRevisionId).not.toBeNull();
    expect(staged.data.related).toBeUndefined();
    expect(await indexRows(source.id)).toHaveLength(0);

    const republished = await publishEntry(deps, editor, {
      entryId: staged.id,
      baseVersion: staged.version,
    });
    expect(republished.data.related).toBe(target.translationGroup);
    const rows = await indexRows(source.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetTranslationGroup).toBe(target.translationGroup);
  });

  it('two entries referencing one target produce two rows, and removing one sources reference leaves the others row', async () => {
    const targetType = await makeTargetType('refSharedTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });

    const sourceType = await makeReferencingType('refSharedSource', [
      targetType.key,
    ]);
    const sourceA = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });
    const sourceB = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });

    const savedA = await saveEntry(deps, editor, {
      entryId: sourceA.id,
      baseVersion: sourceA.version,
      data: { related: target.translationGroup },
    });
    const savedB = await saveEntry(deps, editor, {
      entryId: sourceB.id,
      baseVersion: sourceB.version,
      data: { related: target.translationGroup },
    });
    expect(await indexRows(sourceA.id)).toHaveLength(1);
    expect(await indexRows(sourceB.id)).toHaveLength(1);

    await saveEntry(deps, editor, {
      entryId: savedA.id,
      baseVersion: savedA.version,
      data: {},
    });
    expect(await indexRows(sourceA.id)).toHaveLength(0);
    expect(await indexRows(sourceB.id)).toHaveLength(1);
    expect(savedB.data.related).toBe(target.translationGroup);
  });

  it('an entry with no reference fields writes no rows at all', async () => {
    const plainType = await createContentType(deps, superadmin, {
      key: uniqueKey('refPlainType'),
      labelSingular: 'refPlainType',
      labelPlural: 'refPlainType',
    });
    await addField(deps, superadmin, {
      contentTypeKey: plainType.key,
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: plainType.key,
      locale: 'en',
      data: {},
    });
    const saved = await saveEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
      data: { title: 'Hello' },
    });
    expect(await indexRows(saved.id)).toHaveLength(0);
  });

  it('saving a reference to a target being permanently deleted concurrently either throws ReferenceTargetMissingError or leaves no stored reference to the deleted group once both settle', async () => {
    const targetType = await makeTargetType('refConcurrentTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });

    const sourceType = await makeReferencingType('refConcurrentSource', [
      targetType.key,
    ]);
    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });

    const [saveOutcome, deleteOutcome] = await Promise.allSettled([
      saveEntry(deps, editor, {
        entryId: source.id,
        baseVersion: source.version,
        data: { related: target.translationGroup },
      }),
      deleteEntryPermanently(deps, superadmin, {
        entryId: target.id,
        baseVersion: target.version,
      }),
    ]);

    expect(deleteOutcome.status).toBe('fulfilled');

    // Either the save failed the existence check, or it succeeded because
    // it read the target before the delete committed -- both are
    // acceptable outcomes of this race (D-40); asserted as one boolean so
    // `expect` is never called conditionally.
    const saveOutcomeAcceptable =
      (saveOutcome.status === 'rejected' &&
        saveOutcome.reason instanceof ReferenceTargetMissingError) ||
      (saveOutcome.status === 'fulfilled' &&
        saveOutcome.value.data.related === target.translationGroup);
    expect(saveOutcomeAcceptable).toBe(true);

    // Whichever way the save settled, the two never interleave into a
    // dangling reference: once both are done, no row names the deleted
    // group.
    const rows = await indexRows(source.id);
    const hasNoDanglingReference = rows.every(
      (row) => row.targetTranslationGroup !== target.translationGroup,
    );
    expect(hasNoDanglingReference).toBe(true);
  });
});
