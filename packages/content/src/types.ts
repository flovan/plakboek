/**
 * Shared record and status types for the content engine (TYPE-10). These
 * mirror the camelCase shape returned by `content-types.ts`, `fields.ts`,
 * `entries.ts` and `save.ts` -- no runtime behaviour lives here.
 */

/** `content_entries.status` (D-47): describes the live side only. A
 * separate `draft_revision_id` pointer (not modelled yet in this plan) marks
 * "published with changes pending". */
export const ENTRY_STATUSES = Object.freeze([
  'draft',
  'published',
  'scheduled',
  'trashed',
] as const);
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** `content_types.revision_mode` (D-13): null unless `revisions` is true. */
export const REVISION_MODES = Object.freeze([
  'on_publish',
  'on_every_save',
] as const);
export type RevisionMode = (typeof REVISION_MODES)[number];

/** A content type as stored: `key` is the internal, code-facing identifier
 * (D-05); `slug` is the URL-facing one, independently editable. */
export type ContentTypeRecord = {
  readonly id: string;
  readonly key: string;
  readonly slug: string;
  readonly labelSingular: string;
  readonly labelPlural: string;
  readonly description: string | null;
  readonly routable: boolean;
  readonly urlPattern: string | null;
  readonly singleton: boolean;
  readonly drafts: boolean;
  readonly revisions: boolean;
  readonly revisionMode: RevisionMode | null;
  readonly editLocking: boolean;
  readonly seo: boolean;
  readonly titleFieldKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** A field definition as stored. `fieldType` never changes after creation
 * (D-08); `widget` is chosen independently of it (FIELD-04). */
export type FieldDefinition = {
  readonly id: string;
  readonly contentTypeId: string;
  readonly key: string;
  readonly label: string;
  readonly fieldType: import('./field-types/registry.js').FieldType;
  readonly translatable: boolean;
  readonly required: boolean;
  readonly options: unknown;
  readonly widget: string;
  readonly widgetOptions: unknown;
  readonly defaultValue: unknown;
  readonly sortOrder: number;
};

/** One locale row of one logical entry (I18N-04). Every system field TYPE-10
 * requires plus the scheduling/lock columns D-43 and D-49 add on top. */
export type EntryRecord = {
  readonly id: string;
  readonly contentTypeId: string;
  readonly translationGroup: string;
  readonly publicId: number;
  readonly locale: string;
  readonly slug: string | null;
  readonly status: EntryStatus;
  readonly data: Readonly<Record<string, unknown>>;
  readonly seo: unknown;
  readonly version: number;
  readonly draftRevisionId: string | null;
  readonly liveRevisionId: string | null;
  readonly resolvedPath: string | null;
  readonly lockedBy: string | null;
  readonly lockedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
  readonly firstPublishedAt: Date | null;
  readonly scheduledAt: Date | null;
  readonly trashedAt: Date | null;
};
