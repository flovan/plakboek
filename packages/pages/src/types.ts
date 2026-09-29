/**
 * Shared enums and record shapes for the page and block-tree engine. Types
 * (and the frozen const tuples their unions derive from) only -- no
 * runtime logic lives here.
 */

export const PAGE_STATUSES = Object.freeze([
  'draft',
  'published',
  'scheduled',
  'trashed',
] as const);
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const BLOCK_CHANGE_TYPES = Object.freeze([
  'create',
  'update',
  'move',
  'delete',
] as const);
export type BlockChangeType = (typeof BLOCK_CHANGE_TYPES)[number];

export const BLOCK_REVISION_KINDS = Object.freeze(['save', 'publish'] as const);
export type BlockRevisionKind = (typeof BLOCK_REVISION_KINDS)[number];

/** `page` is the only legal value this plan's migration allows
 * (`page_blocks_owner_type_check`); the column, its index and this engine
 * are written polymorphically so Phase 19 can widen it without a
 * destructive migration (D-24). */
export const OWNER_TYPES = Object.freeze(['page'] as const);
export type OwnerType = (typeof OWNER_TYPES)[number];

/** The tree read/write layer's primary key: an `(owner_type, owner_id,
 * locale)` tuple, never a bare `pageId` -- a page is one variant of owner,
 * not the identity of the tree (see the plan's own
 * `<assumption_delta_decision>`). */
export type OwnerRef = {
  readonly ownerType: OwnerType;
  readonly ownerId: string;
  readonly locale: string;
};

export type PageRecord = {
  readonly id: string;
  readonly translationGroup: string;
  readonly locale: string;
  readonly parentPageId: string | null;
  readonly slug: string;
  readonly slugSource: 'generated' | 'manual';
  readonly path: string;
  readonly resolvedPath: string | null;
  readonly title: string;
  readonly status: PageStatus;
  readonly seo: unknown;
  readonly version: number;
  readonly livePublicationId: string | null;
  readonly lockedBy: string | null;
  readonly lockedAt: Date | null;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
  readonly firstPublishedAt: Date | null;
  readonly scheduledAt: Date | null;
  readonly trashedAt: Date | null;
};

export type BlockRecord = {
  readonly id: string;
  readonly ownerType: OwnerType;
  readonly ownerId: string;
  readonly locale: string;
  readonly parentBlockId: string | null;
  readonly blockType: string;
  readonly props: unknown;
  readonly schemaVersion: number;
  readonly depth: number;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** A tree-read node: `BlockRecord` plus its resolved children and the
 * upcast-on-read outcome (D-11, D-12, D-15) -- `degraded: true` carries a
 * `degradedReason` naming why the stored `props` could not be brought to
 * the registry's current shape; the stored row is never rewritten because
 * of it. */
export type BlockNode = (
  | (BlockRecord & { readonly degraded: false })
  | (BlockRecord & {
      readonly degraded: true;
      readonly degradedReason: string;
    })
) & { readonly children: readonly BlockNode[] };
