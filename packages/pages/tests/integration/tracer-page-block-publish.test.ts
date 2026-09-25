import { randomUUID } from 'node:crypto';
import {
  PermissionDeniedError,
  SUPERADMIN_ROLE_KEY,
  createAuditRecorder,
  createUserWithRole,
  type AuditActor,
  type AuditRecorder,
} from '@plakboek/auth';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { getPage } from '../../src/pages.js';
import { createPage } from '../../src/pages.js';
import { publishPage } from '../../src/publish.js';
import { BlockPropsValidationError, defineBlocks } from '../../src/registry.js';
import {
  insertBlock,
  readBlockTree,
  StaleBlockVersionError,
  StalePageVersionError,
  updateBlockProps,
} from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

// The default `editor` role (packages/permissions/src/roles.ts) already
// holds `pages:create` -- the plan's own literal tracer narrative names
// "the editor role" for the permission-denied assertion, but that no longer
// holds against the shipped role catalogue. A purpose-built `viewer` role
// (read-only, no `pages:create`) is used instead so the denied-permission
// assertion is actually true against real code, while still exercising the
// exact same recorder/audit path a denied editor action would.
const roles = defineRoles({
  ...defaultRoles,
  viewer: ['pages:read'],
});

async function readStoredPropsText(
  handle: Db,
  blockId: string,
): Promise<string | undefined> {
  const [row] = await handle.sql<{ propsText: string }[]>`
    SELECT props::text AS "propsText" FROM page_blocks WHERE id = ${blockId}
  `;
  return row?.propsText;
}

describe('Phase 4 tracer: declare blocks, create a page, insert a section and a block, edit, read the tree, publish', () => {
  it('wires host config through page/block-tree creation and version-checked, validated, audited saves and publish', async () => {
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
      const clock = (): Date => new Date('2026-09-25T09:00:00.000Z');

      const superadminUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'owner@example.com',
        name: 'Owner',
        roleKey: SUPERADMIN_ROLE_KEY,
      });
      const viewerUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'viewer@example.com',
        name: 'Viewer',
        roleKey: 'viewer',
      });
      const superadmin: AuditActor = {
        userId: superadminUser.userId,
        roleKey: superadminUser.roleKey,
      };
      const viewer: AuditActor = {
        userId: viewerUser.userId,
        roleKey: viewerUser.roleKey,
      };

      const config = definePagesConfig({
        content: defineContentConfig({
          locales: ['en', 'nl'],
          defaultLocale: 'en',
          timezone: 'Europe/Brussels',
        }),
        blocks: defineBlocks([
          {
            key: 'section',
            kind: 'section',
            editor: { label: 'Section' },
            schemaVersion: 1,
            properties: {
              width: {
                fieldType: 'select',
                label: 'Width',
                options: {
                  choices: [
                    { value: 'full', labels: { en: 'Full', nl: 'Volledig' } },
                    {
                      value: 'contained',
                      labels: { en: 'Contained', nl: 'Ingesloten' },
                    },
                  ],
                },
              },
            },
          },
          {
            key: 'heading',
            editor: { label: 'Heading' },
            schemaVersion: 1,
            properties: {
              text: {
                fieldType: 'short_text',
                label: 'Text',
                required: true,
                options: { maxLength: 120 },
              },
            },
          },
          // schemaVersion 3 with a declared minSupportedVersion of 3 and a
          // full 2..3 upcaster chain (04-04's D-10: a declaration must
          // cover every step from 2 to schemaVersion contiguously, or
          // defineBlocks itself refuses at boot) -- exercises
          // upcastOnRead's 'below-floor' degraded path below via a raw row
          // stored under that floor.
          {
            key: 'note',
            editor: { label: 'Note' },
            schemaVersion: 3,
            minSupportedVersion: 3,
            upcasters: {
              2: (props) => props,
              3: (props) => props,
            },
            properties: {},
          },
        ]),
        sectionNestingDepth: 2,
        blockDepthCeiling: 12,
      });

      const deps: PagesDeps = {
        db: handle.db,
        recorder,
        resolver,
        config,
        now: clock,
      };

      const page = await createPage(deps, superadmin, {
        locale: 'en',
        title: 'About us',
      });
      expect(page.slug).toBe('about-us');
      expect(page.path).toBe('about-us');
      expect(page.status).toBe('draft');
      expect(page.version).toBe(1);

      const owner = {
        ownerType: 'page' as const,
        ownerId: page.id,
        locale: page.locale,
      };

      const section = await insertBlock(deps, superadmin, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      expect(section.depth).toBe(0);
      expect(section.schemaVersion).toBe(1);

      const pageAfterSection = await getPage(handle.db, page.id);
      expect(pageAfterSection?.version).toBe(2);

      const heading = await insertBlock(deps, superadmin, {
        owner,
        blockType: 'heading',
        parentBlockId: section.id,
        props: { text: 'Welcome' },
        basePageVersion: 2,
      });
      expect(heading.depth).toBe(1);
      expect(heading.parentBlockId).toBe(section.id);

      const pageAfterHeading = await getPage(handle.db, page.id);
      expect(pageAfterHeading?.version).toBe(3);

      // Two concurrent property edits from the same base version: exactly
      // one must win (returning version 2) and the other must lose with
      // `StaleBlockVersionError`, never both applying -- the discrimination
      // check for the `FOR UPDATE` + version-checked write shape.
      const concurrentResults = await Promise.allSettled([
        updateBlockProps(deps, superadmin, {
          blockId: heading.id,
          baseVersion: heading.version,
          props: { text: 'Welcome, updated' },
        }),
        updateBlockProps(deps, superadmin, {
          blockId: heading.id,
          baseVersion: heading.version,
          props: { text: 'Welcome, contested' },
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
      expect(rejected[0]?.reason).toBeInstanceOf(StaleBlockVersionError);
      const updatedHeading =
        fulfilled[0]?.status === 'fulfilled' ? fulfilled[0].value : undefined;
      expect(updatedHeading?.version).toBe(heading.version + 1);
      const propsTextAfterUpdate = await readStoredPropsText(
        handle,
        heading.id,
      );

      const staleError: unknown = await updateBlockProps(deps, superadmin, {
        blockId: heading.id,
        baseVersion: heading.version,
        props: { text: 'Stale write' },
      }).catch((caught: unknown) => caught);
      expect(staleError).toBeInstanceOf(StaleBlockVersionError);
      expect(await readStoredPropsText(handle, heading.id)).toBe(
        propsTextAfterUpdate,
      );

      const validationError: unknown = await updateBlockProps(
        deps,
        superadmin,
        {
          blockId: heading.id,
          baseVersion: updatedHeading?.version ?? -1,
          props: { text: '' },
        },
      ).catch((caught: unknown) => caught);
      expect(validationError).toBeInstanceOf(BlockPropsValidationError);
      expect(
        (validationError as BlockPropsValidationError).issues.some(
          (issue) => issue.propertyKey === 'text',
        ),
      ).toBe(true);

      const propsBeforeRead = await readStoredPropsText(handle, heading.id);
      const tree = await readBlockTree(handle.db, owner);
      const propsAfterRead = await readStoredPropsText(handle, heading.id);
      expect(propsAfterRead).toBe(propsBeforeRead);

      expect(tree).toHaveLength(1);
      const rootNode = tree[0];
      expect(rootNode?.id).toBe(section.id);
      expect(rootNode?.degraded).toBe(false);
      expect(rootNode?.children).toHaveLength(1);
      const childNode = rootNode?.children[0];
      expect(childNode?.id).toBe(heading.id);
      expect(childNode?.degraded).toBe(false);

      const stalePageError: unknown = await insertBlock(deps, superadmin, {
        owner,
        blockType: 'heading',
        parentBlockId: null,
        props: { text: 'Another heading' },
        basePageVersion: 2,
      }).catch((caught: unknown) => caught);
      expect(stalePageError).toBeInstanceOf(StalePageVersionError);

      const pageBeforePublish = await getPage(handle.db, page.id);
      expect(pageBeforePublish?.version).toBe(3);

      const publication = await publishPage(deps, superadmin, {
        pageId: page.id,
        baseVersion: pageBeforePublish?.version ?? 0,
      });
      expect(publication.snapshot).toMatchObject({
        blocks: [
          {
            id: section.id,
            blockType: 'section',
            children: [{ id: heading.id, blockType: 'heading' }],
          },
        ],
      });
      expect(Object.keys(publication.revisionManifest).sort()).toEqual(
        [section.id, heading.id].sort(),
      );

      const pageAfterPublish = await getPage(handle.db, page.id);
      expect(pageAfterPublish?.status).toBe('published');
      expect(pageAfterPublish?.livePublicationId).toBe(publication.id);

      // A row whose `block_type` has no registry entry (e.g. a block a host
      // later removed from its config) must degrade, not throw -- inserted
      // directly since `insertBlock` itself refuses an unregistered type.
      // Added after publish so it cannot affect the snapshot assertions above.
      const [unknownRow] = await handle.sql<{ id: string }[]>`
        INSERT INTO page_blocks (
          owner_type, owner_id, locale, parent_block_id, block_type, props,
          schema_version, depth, sort_order, version, created_at, updated_at
        ) VALUES (
          'page', ${page.id}, 'en', NULL, 'noLongerRegistered', '{}'::jsonb,
          1, 0, 5000, 1, ${clock().toISOString()}, ${clock().toISOString()}
        ) RETURNING id
      `;
      const treeWithUnknown = await readBlockTree(handle.db, owner);
      const unknownNode = treeWithUnknown.find(
        (node) => node.id === unknownRow?.id,
      );
      expect(unknownNode?.degraded).toBe(true);
      expect(
        unknownNode?.degraded === true ? unknownNode.degradedReason : undefined,
      ).toBe('unknown-block-type');

      // A registered block whose stored `schema_version` (1) is below its
      // declared `minSupportedVersion` (3, `note`) must degrade with
      // reason `'below-floor'` -- this is what proves `readBlockTree`
      // actually runs `upcastOnRead` per row, not just a registry-lookup
      // check. (04-04's D-10 requires a full contiguous upcaster chain
      // from 2..schemaVersion at declare time, so a genuinely missing
      // upcaster step is now a boot-time `BlockConfigError`, not a
      // read-time degradation -- `minSupportedVersion` is the surviving
      // degraded-read path for a stored version older than a block's
      // declared floor.)
      const [belowFloorRow] = await handle.sql<{ id: string }[]>`
        INSERT INTO page_blocks (
          owner_type, owner_id, locale, parent_block_id, block_type, props,
          schema_version, depth, sort_order, version, created_at, updated_at
        ) VALUES (
          'page', ${page.id}, 'en', NULL, 'note', '{}'::jsonb,
          1, 0, 6000, 1, ${clock().toISOString()}, ${clock().toISOString()}
        ) RETURNING id
      `;
      const treeWithBelowFloor = await readBlockTree(handle.db, owner);
      const belowFloorNode = treeWithBelowFloor.find(
        (node) => node.id === belowFloorRow?.id,
      );
      expect(belowFloorNode?.degraded).toBe(true);
      expect(
        belowFloorNode?.degraded === true
          ? belowFloorNode.degradedReason
          : undefined,
      ).toBe('below-floor');

      const deniedError: unknown = await createPage(deps, viewer, {
        locale: 'en',
        title: 'Contact',
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
      expect(allowedActions).toContain('page.create');
      expect(allowedActions).toContain('block.insert');
      expect(allowedActions).toContain('block.update');
      expect(allowedActions).toContain('page.publish');
      expect(auditRows.every((row) => row.actorUserId !== null)).toBe(true);
      const deniedRows = auditRows.filter(
        (row) => row.outcome === 'denied' && row.action === 'page.create',
      );
      expect(deniedRows).toHaveLength(1);
    } finally {
      if (handle !== undefined) await handle.close();
      await testDatabase.drop();
    }
  });
});
