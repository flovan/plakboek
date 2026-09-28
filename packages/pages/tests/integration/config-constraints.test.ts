/**
 * `definePagesConfig`'s per-property installation constraints (BLOCK-08,
 * D-04), proven end to end against real Postgres through the REAL write and
 * publish paths (`insertBlock`, `publishPage`) -- not only against a
 * hand-built `BlockDefinition` the way `tests/unit/registry-constraints.test.ts`
 * already does. This is the exact gap 04-09's SUMMARY recorded: a
 * `hidden`/`fixed`/`narrowed` constraint declared through
 * `definePagesConfig({ constraints: [...] })` type-checked and booted
 * cleanly but had zero effect on `insertBlock`/`buildPageSnapshot`, because
 * `applyBlockConstraints`'s resolved definitions never reached the
 * module-level registry `getBlockDefinition` (and therefore every real
 * write/publish path) reads from.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
  type AuditDatabase,
  type AuditRecorder,
} from '@plakboek/auth';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { constrainBlock } from '../../src/constraints.js';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { createPage, getPage } from '../../src/pages.js';
import { publishPage } from '../../src/publish.js';
import { BlockPropsValidationError, defineBlocks } from '../../src/registry.js';
import { insertBlock } from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

describe('definePagesConfig constraints enforced on real writes/publishes (BLOCK-08, D-04)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-09-26T09:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;

    const resolver: PermissionResolver = createPermissionResolver(defaultRoles);
    const recorder: AuditRecorder = createAuditRecorder({ db, resolver });

    const config = definePagesConfig({
      content: defineContentConfig({
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'UTC',
      }),
      blocks: defineBlocks([
        {
          key: 'section',
          kind: 'section',
          editor: { label: 'Section' },
          schemaVersion: 1,
          properties: {},
        },
        {
          key: 'card',
          editor: { label: 'Card' },
          schemaVersion: 1,
          properties: {
            tone: {
              fieldType: 'select',
              label: 'Tone',
              options: {
                choices: [
                  { value: 'info', labels: { en: 'Info' } },
                  { value: 'warning', labels: { en: 'Warning' } },
                  { value: 'danger', labels: { en: 'Danger' } },
                ],
              },
            },
            variant: {
              fieldType: 'select',
              label: 'Variant',
              options: {
                choices: [
                  { value: 'a', labels: { en: 'A' } },
                  { value: 'b', labels: { en: 'B' } },
                  { value: 'c', labels: { en: 'C' } },
                ],
              },
            },
            title: { fieldType: 'short_text', label: 'Title', options: {} },
            // Never legitimately reachable through `insertBlock` once
            // `hidden` -- exists purely to prove a caller cannot smuggle a
            // value for it into storage (test 3 below).
            secret: { fieldType: 'short_text', label: 'Secret', options: {} },
          },
        },
      ]),
      constraints: [
        constrainBlock('card', {
          tone: { fixed: 'warning' },
          variant: { allow: ['a', 'b'] },
          secret: 'hidden',
        }),
      ],
    });

    const superadminUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: superadminUser.userId, roleKey: superadminUser.roleKey };
    deps = { db, recorder, resolver, config, now: clock };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  async function blockCount(pageId: string): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM page_blocks WHERE owner_id = ${pageId}
    `;
    return Number(row?.count ?? '0');
  }

  it('refuses an insertBlock write conflicting with a fixed constraint (D-04)', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Fixed',
    });
    const owner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: 'en',
    };
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'card',
      parentBlockId: section.id,
      // `danger` is one of `tone`'s own declared choices -- the
      // UNCONSTRAINED field type would accept it. Only the registered
      // `fixed: 'warning'` constraint refuses it.
      props: { tone: 'danger', variant: 'a', title: 'Hi' },
      basePageVersion: 2,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlockPropsValidationError);
    expect((error as BlockPropsValidationError).issues).toContainEqual({
      propertyKey: 'tone',
      code: 'INVALID',
    });
    expect(await blockCount(page.id)).toBe(1); // only the section
  });

  it('refuses an insertBlock write with an out-of-range value under a narrowed constraint (D-04)', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Narrowed',
    });
    const owner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: 'en',
    };
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'card',
      parentBlockId: section.id,
      // `c` is one of `variant`'s own declared choices -- the
      // UNCONSTRAINED field type would accept it. Only the registered
      // `allow: ['a', 'b']` constraint refuses it.
      props: { tone: 'warning', variant: 'c', title: 'Hi' },
      basePageVersion: 2,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlockPropsValidationError);
    expect((error as BlockPropsValidationError).issues).toContainEqual({
      propertyKey: 'variant',
      code: 'INVALID',
    });
    expect(await blockCount(page.id)).toBe(1); // only the section
  });

  it('refuses an insertBlock write naming a hidden constrained property, so it can never reach a published snapshot (D-04)', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Hidden',
    });
    const owner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: 'en',
    };
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'card',
      parentBlockId: section.id,
      props: {
        tone: 'warning',
        variant: 'a',
        title: 'Hi',
        secret: 'leaked-value',
      },
      basePageVersion: 2,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlockPropsValidationError);
    expect((error as BlockPropsValidationError).issues).toContainEqual({
      propertyKey: 'secret',
      code: 'UNKNOWN',
    });

    // A legitimate write (never naming the hidden property) succeeds, and
    // the published snapshot never carries a `secret` key at all.
    const card = await insertBlock(deps, actor, {
      owner,
      blockType: 'card',
      parentBlockId: section.id,
      props: { tone: 'warning', variant: 'a', title: 'Hi' },
      basePageVersion: 2,
    });

    const pageBeforePublish = await getPage(db, page.id);
    const publication = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageBeforePublish?.version ?? 0,
    });

    const cardSnapshot = publication.snapshot.blocks
      .flatMap((block) => block.children)
      .find((block) => block.id === card.id);
    expect(cardSnapshot?.props).toEqual({
      tone: 'warning',
      variant: 'a',
      title: 'Hi',
    });
    expect(cardSnapshot?.props).not.toHaveProperty('secret');
  });
});
