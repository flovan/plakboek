# @plakboek/content

Headless content types, fields, locale-aware entries and revisions for
Plakboek CMS installations: type and field definitions as database rows, a
shared JSONB entry store, per-field validation, revisions, edit locking,
slug and URL-pattern resolution. No admin UI ships here -- building and
authoring content types is a later phase; this package returns the impact
reports and previews that UI warns from.

## Install

```sh
pnpm add @plakboek/content
```

## Status

The Phase 3 (Content Type & Field Engine) surface is complete. Everything
a host needs -- content type and field modelling, entry save/publish/
lifecycle, locking, revisions, translations, singletons, the boot-time
locale check, SEO, seeding and reference resolution -- is exported from
the package entry point and listed below. Routes, screens and the
authoring UI that call these functions belong to the host and to later
phases.

## Public API

Every export of `@plakboek/content`, grouped the way `src/index.ts`
groups them. `tests/unit/public-api.test.ts` compares these tables with
the entry point, so an export cannot be added or removed without updating
them.

Nothing else is reachable from the entry point. In particular the save
transaction body and its permission/snapshot helpers, the unfiltered and
row-locking entry reads, the field-type registration function, every
field type's own definition constant, the transaction-scoped writers
(revisions, URL history, key history, the reference index, slug
generation), and every Drizzle schema table stay internal: with them a
consumer could write or read content around the audited, version-checked,
locale-filtered paths this package guarantees.

### Host config

| Export                   | Kind     | Purpose                                                                                                 |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `defineContentConfig`    | function | Validates and freezes a host's locales, default locale and timezone; collects every problem             |
| `ContentConfigError`     | class    | Thrown by `defineContentConfig` with every problem found                                                |
| `reportContentWarning`   | function | Calls a host-supplied hook (seed drift, removed locale) so it can never throw or reject into the caller |
| `ContentConfig`          | type     | `locales`, `defaultLocale`, `timezone`                                                                  |
| `ContentConfigIssueCode` | type     | `NO_LOCALES`, `INVALID_LOCALE`, `DUPLICATE_LOCALE`, `DEFAULT_LOCALE_NOT_ENABLED`, `INVALID_TIMEZONE`    |
| `ContentConfigIssue`     | type     | One `defineContentConfig` problem                                                                       |
| `ContentHooks`           | type     | Optional `onSeedDrift`/`onLocaleRemoved` hooks a host passes on `ContentDeps`                           |
| `ContentDeps`            | type     | The dependency bag every engine operation takes: `db`, `config`, `recorder`, and optionally `hooks`     |
| `SeedDriftEvent`         | type     | What `onSeedDrift` receives when an applied seed item's stored row disagrees with the seed              |
| `LocaleRemovedEvent`     | type     | What `onLocaleRemoved` receives when the boot check finds stored entries in a no-longer-enabled locale  |

### Status and revision-mode catalogues

| Export              | Kind     | Purpose                                                 |
| ------------------- | -------- | ------------------------------------------------------- |
| `ENTRY_STATUSES`    | constant | Frozen `['draft', 'published', 'scheduled', 'trashed']` |
| `REVISION_MODES`    | constant | Frozen `['on_publish', 'on_every_save']`                |
| `EntryStatus`       | type     | One of `ENTRY_STATUSES`                                 |
| `RevisionMode`      | type     | One of `REVISION_MODES`                                 |
| `ContentTypeRecord` | type     | A content type as stored, in camelCase                  |
| `FieldDefinition`   | type     | A field as stored, in camelCase                         |
| `EntryRecord`       | type     | An entry as stored, in camelCase                        |

### Field-type registry (read side)

| Export                   | Kind     | Purpose                                                                             |
| ------------------------ | -------- | ----------------------------------------------------------------------------------- |
| `FIELD_TYPES`            | constant | The sixteen registered field types, in `content_type_fields_field_type_check` order |
| `isFieldType`            | function | Whether a string is one of `FIELD_TYPES`                                            |
| `getFieldTypeDefinition` | function | The registered `FieldTypeDefinition` for a field type                               |
| `parseFieldOptions`      | function | Validates a field type's `options` against its own schema                           |
| `UnknownFieldTypeError`  | class    | A `field_type` string has no registered definition                                  |
| `FieldDefinitionError`   | class    | Invalid `options` for a field type, or an empty generated field key                 |
| `FieldType`              | type     | One of `FIELD_TYPES`                                                                |
| `FieldTypeDefinition`    | type     | One field type's contract: options schema, value-schema builder, widgets            |

### Field-type validation constants

| Export                  | Kind     | Purpose                                                          |
| ----------------------- | -------- | ---------------------------------------------------------------- |
| `PATTERN_MAX_LENGTH`    | constant | Maximum length of `short_text`'s optional `pattern` option       |
| `isSafePattern`         | function | Define-time ReDoS guard for `short_text`'s `pattern` option      |
| `SHORT_TEXT_MAX_LENGTH` | constant | Maximum stored length of a `short_text` value                    |
| `LONG_TEXT_MAX_LENGTH`  | constant | Maximum stored length of a `long_text` value                     |
| `RICH_TEXT_MAX_BYTES`   | constant | Maximum serialized size of a `rich_text` document                |
| `RICH_TEXT_MAX_DEPTH`   | constant | Maximum nesting depth of a `rich_text` document                  |
| `URL_MAX_LENGTH`        | constant | Maximum stored length of a `url` value                           |
| `JSON_FIELD_MAX_BYTES`  | constant | Maximum serialized size of a `json` value                        |
| `CHOICE_VALUE_PATTERN`  | constant | Allowed shape of a `select`/`multi_select` choice's stable value |
| `ASSET_ID_PATTERN`      | constant | Allowed shape of an `image`/`file` opaque asset id               |
| `REPEATER_MAX_ITEMS`    | constant | Maximum number of items a `repeater` value may hold              |
| `FieldTypeOptionsMap`   | type     | Every field type's own `options` shape, keyed by field type      |
| `FieldTypeWidgetMap`    | type     | Every field type's own widget shape, keyed by field type         |

### Entry data validation

| Export                     | Kind     | Purpose                                                                   |
| -------------------------- | -------- | ------------------------------------------------------------------------- |
| `validateEntryData`        | function | Validates an entry's data against a type's field definitions, collect-all |
| `FieldValidationError`     | class    | Thrown by `validateEntryData` with every issue found                      |
| `FieldValidationIssueCode` | type     | `REQUIRED`, `INVALID_VALUE`, `UNKNOWN_FIELD`, `INVALID_DATA`              |
| `FieldValidationIssue`     | type     | One `validateEntryData` problem                                           |

### Slugs

| Export              | Kind     | Purpose                                                                        |
| ------------------- | -------- | ------------------------------------------------------------------------------ |
| `normalizeSlug`     | function | Strips diacritics and normalises a label into a slug                           |
| `isNormalizedSlug`  | function | Whether a string is already in normalised slug form                            |
| `SLUG_MAX_LENGTH`   | constant | `200`: maximum length of a stored slug                                         |
| `SLUG_PATTERN`      | constant | The normalised slug shape `normalizeSlug` produces                             |
| `SlugConflictError` | class    | A slug is already held by another entry in the same type and locale            |
| `InvalidSlugError`  | class    | A hand-typed slug is not already normalised; carries the normalised suggestion |

### URL patterns

| Export                   | Kind     | Purpose                                                             |
| ------------------------ | -------- | ------------------------------------------------------------------- |
| `URL_PATTERN_TOKENS`     | constant | `{slug}`, `{id}` and the six date tokens a URL pattern may use      |
| `URL_PATTERN_MAX_LENGTH` | constant | `500`: maximum length of a URL pattern string                       |
| `UrlPatternError`        | class    | Thrown by `parseUrlPattern` with every malformation found           |
| `parseUrlPattern`        | function | Parses a URL pattern string, collecting every issue                 |
| `resolveUrlPath`         | function | Resolves a parsed pattern against one entry's tokens, in a timezone |
| `usesSlugToken`          | function | Whether a parsed pattern uses `{slug}`                              |
| `usesDateTokens`         | function | Whether a parsed pattern uses any of the six date tokens            |
| `UrlPatternToken`        | type     | One of `URL_PATTERN_TOKENS`                                         |
| `UrlPatternIssueCode`    | type     | One `parseUrlPattern` problem code                                  |
| `UrlPatternIssue`        | type     | One `parseUrlPattern` problem                                       |
| `ParsedUrlPattern`       | type     | The result of `parseUrlPattern`                                     |
| `UrlPathInput`           | type     | What `resolveUrlPath`/`computeEntryPath` need from one entry        |

### Content types

| Export                              | Kind     | Purpose                                                                             |
| ----------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `TYPE_KEY_PATTERN`                  | constant | Allowed shape of a content type's `key`                                             |
| `LABEL_MAX_LENGTH`                  | constant | Maximum length of a content type's or field's label                                 |
| `createContentType`                 | function | Creates a content type; audited, validated, collect-all                             |
| `getContentTypeByKey`               | function | Reads one content type by its `key`, or `null`                                      |
| `ContentTypeValidationError`        | class    | Thrown by `createContentType` with every problem found                              |
| `ContentTypeConflictError`          | class    | A content type's `key` or `slug` already exists                                     |
| `PendingDraftsError`                | class    | Turning drafts off while an entry has a pending draft revision                      |
| `RoutableInUseError`                | class    | Turning routable off while an entry is published                                    |
| `ContentTypeHasEntriesError`        | class    | Changing singleton/routable on a type that already holds entries                    |
| `ContentTypeReferencedError`        | class    | Deleting a content type that is the only allowed type on a reference field          |
| `TitleFieldError`                   | class    | `setTitleField` given an unknown key, wrong type, or non-routable type              |
| `updateContentTypeSettings`         | function | Updates labels, description and the routable/drafts/revisions/editLocking/seo flags |
| `setContentTypeSlug`                | function | Changes a content type's `slug`, independent of its `key`                           |
| `computeContentTypeKeyRenameImpact` | function | Previews what renaming a content type's `key` would rewrite                         |
| `renameContentTypeKey`              | function | Renames a content type's `key`, rewriting every referencing field                   |
| `setTitleField`                     | function | Designates which `short_text` field is a routable type's title                      |
| `computeContentTypeDeleteImpact`    | function | Previews what deleting a content type would refuse or change                        |
| `deleteContentType`                 | function | Deletes a content type holding no entries                                           |
| `CreateContentTypeInput`            | type     | Input to `createContentType`                                                        |
| `ContentTypeValidationIssueCode`    | type     | One `createContentType` problem code                                                |
| `ContentTypeValidationIssue`        | type     | One `createContentType` problem                                                     |
| `TitleFieldErrorReason`             | type     | `NOT_ROUTABLE`, `UNKNOWN_FIELD`, `WRONG_TYPE`                                       |
| `UpdateContentTypeSettingsInput`    | type     | Input to `updateContentTypeSettings`                                                |
| `SetContentTypeSlugInput`           | type     | Input to `setContentTypeSlug`                                                       |
| `RenameContentTypeKeyInput`         | type     | Input to `renameContentTypeKey`                                                     |
| `SetTitleFieldInput`                | type     | Input to `setTitleField`                                                            |
| `DeleteContentTypeInput`            | type     | Input to `deleteContentType`                                                        |

### Fields

| Export                     | Kind     | Purpose                                                                          |
| -------------------------- | -------- | -------------------------------------------------------------------------------- |
| `FIELD_KEY_PATTERN`        | constant | Allowed shape of a field's `key`                                                 |
| `fieldKeyFromLabel`        | function | Generates a camelCase field key from a label                                     |
| `FieldKeyConflictError`    | class    | A field `key` already exists on its content type                                 |
| `addField`                 | function | Attaches a field to a content type; audited, validated, collect-all              |
| `computeAddFieldImpact`    | function | Previews what a required new field would backfill or block                       |
| `listFields`               | function | Lists a content type's fields                                                    |
| `FieldTypeImmutableError`  | class    | `updateField` given a `fieldType` property -- a field's type never changes       |
| `computeFieldUpdateImpact` | function | Previews what updating a field (e.g. making it required) would backfill or block |
| `updateField`              | function | Updates a field's definition, `fieldType` excluded                               |
| `computeFieldKeyUsage`     | function | Previews what renaming a field's `key` would move                                |
| `renameField`              | function | Renames a field's `key`, moving its value in every entry                         |
| `duplicateField`           | function | Copies a field's definition, and by default its values, under a new key          |
| `computeFieldDeleteImpact` | function | Previews what deleting a field would clear                                       |
| `deleteField`              | function | Removes a field and its key from every entry's data                              |
| `AddFieldInput`            | type     | Input to `addField`                                                              |
| `UpdateFieldInput`         | type     | Input to `updateField`                                                           |
| `RenameFieldInput`         | type     | Input to `renameField`                                                           |
| `DuplicateFieldInput`      | type     | Input to `duplicateField`                                                        |
| `DeleteFieldInput`         | type     | Input to `deleteField`                                                           |

### Key-rename history

| Export                 | Kind     | Purpose                                                       |
| ---------------------- | -------- | ------------------------------------------------------------- |
| `listFieldKeyHistory`  | function | Lists a content type's field-key rename history, newest first |
| `FieldKeyHistoryEntry` | type     | One recorded field-key rename                                 |

### Impact report shapes

| Export                       | Kind | Purpose                                                               |
| ---------------------------- | ---- | --------------------------------------------------------------------- |
| `ReferencingField`           | type | A field on another content type that references the one being changed |
| `ContentTypeDeleteImpact`    | type | The result of `computeContentTypeDeleteImpact`                        |
| `ContentTypeKeyRenameImpact` | type | The result of `computeContentTypeKeyRenameImpact`                     |
| `FieldKeyUsage`              | type | The result of `computeFieldKeyUsage`                                  |
| `FieldDeleteImpact`          | type | The result of `computeFieldDeleteImpact`                              |
| `AddFieldImpact`             | type | The result of `computeAddFieldImpact`                                 |
| `FieldUpdateImpact`          | type | The result of `computeFieldUpdateImpact`                              |

### Entries (reads and creation)

| Export                  | Kind     | Purpose                                                                  |
| ----------------------- | -------- | ------------------------------------------------------------------------ |
| `createEntry`           | function | Creates an entry in one locale, starting or joining a translation group  |
| `findEntry`             | function | Reads one entry by id, excluding a removed locale                        |
| `findTranslations`      | function | Reads every locale row of a translation group, excluding removed locales |
| `listEntries`           | function | Lists a content type's entries in one required, enabled locale           |
| `LocaleNotEnabledError` | class    | An operation given a locale not in `ContentConfig.locales`               |
| `EntryNotFoundError`    | class    | An entry id does not exist                                               |
| `CreateEntryInput`      | type     | Input to `createEntry`                                                   |
| `FindEntryInput`        | type     | Input to `findEntry`                                                     |
| `FindTranslationsInput` | type     | Input to `findTranslations`                                              |
| `ListEntriesInput`      | type     | Input to `listEntries`                                                   |

### Save

| Export              | Kind     | Purpose                                                                                       |
| ------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `saveEntry`         | function | Saves an entry's data/slug/seo: live when drafts are off, staged as a pending draft otherwise |
| `StaleVersionError` | class    | The caller's `baseVersion` no longer matches the stored row                                   |
| `SaveEntryInput`    | type     | Input to `saveEntry`                                                                          |

### Publish

| Export                   | Kind     | Purpose                                                                                                |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `publishEntry`           | function | Publishes an entry: freezes the slug at first publish, materialises the path, promotes a pending draft |
| `SlugRequiredError`      | class    | Publishing a routable entry with no slug                                                               |
| `EntryStateChangedError` | class    | The content type's `drafts` setting changed between the permission decision and the write              |
| `PublishEntryInput`      | type     | Input to `publishEntry`                                                                                |

### Routing

| Export                               | Kind     | Purpose                                                                        |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------ |
| `computeEntryPath`                   | function | Computes an entry's resolved path from its type's URL pattern, without writing |
| `computeUrlPatternChangeImpact`      | function | Previews what changing a content type's URL pattern would move or collide      |
| `setUrlPattern`                      | function | Changes a content type's URL pattern, recomputing every published entry's path |
| `UrlPatternRequiredError`            | class    | A routable content type has no URL pattern configured                          |
| `UrlCollisionError`                  | class    | A second entry would resolve to a path already published in the same locale    |
| `UrlPatternInUseError`               | class    | Clearing a URL pattern while entries are still published under it              |
| `UrlPatternCollisionError`           | class    | A URL pattern change would give two published entries the same path            |
| `ComputeEntryPathContentType`        | type     | What `computeEntryPath` needs from a content type                              |
| `UrlPatternCollision`                | type     | One `(locale, path)` pair a pattern change would give to more than one entry   |
| `ComputeUrlPatternChangeImpactInput` | type     | Input to `computeUrlPatternChangeImpact`                                       |
| `UrlPatternChangeImpact`             | type     | The result of `computeUrlPatternChangeImpact`                                  |
| `SetUrlPatternInput`                 | type     | Input to `setUrlPattern`                                                       |
| `SetUrlPatternResult`                | type     | The result of `setUrlPattern`                                                  |

### Lifecycle (unpublish, schedule, trash)

| Export                                   | Kind     | Purpose                                                                                     |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `unpublishEntry`                         | function | Returns a published entry to draft, clearing its resolved path                              |
| `scheduleEntry`                          | function | Sets a future `scheduledAt`; never publishes                                                |
| `unscheduleEntry`                        | function | Clears `scheduledAt`                                                                        |
| `trashEntry`                             | function | Trashes an entry, clearing any live path                                                    |
| `computeEntryTrashImpact`                | function | Reports how many entries reference the one being trashed                                    |
| `restoreEntryFromTrash`                  | function | Restores a trashed entry to draft, never straight to published                              |
| `computeEntryPermanentDeleteImpact`      | function | Previews what permanently deleting an entry would strip or block                            |
| `deleteEntryPermanently`                 | function | Deletes one locale row; strips the group's id from every reference when it was the last row |
| `EntryStatusError`                       | class    | A lifecycle operation given an entry in the wrong status                                    |
| `ScheduleNotInFutureError`               | class    | `scheduleEntry` given a past or present instant                                             |
| `UnpublishEntryInput`                    | type     | Input to `unpublishEntry`                                                                   |
| `ScheduleEntryInput`                     | type     | Input to `scheduleEntry`                                                                    |
| `UnscheduleEntryInput`                   | type     | Input to `unscheduleEntry`                                                                  |
| `TrashEntryInput`                        | type     | Input to `trashEntry`                                                                       |
| `EntryTrashImpact`                       | type     | The result of `computeEntryTrashImpact`                                                     |
| `ComputeEntryTrashImpactInput`           | type     | Input to `computeEntryTrashImpact`                                                          |
| `RestoreEntryFromTrashInput`             | type     | Input to `restoreEntryFromTrash`                                                            |
| `EntryPermanentDeleteImpact`             | type     | The result of `computeEntryPermanentDeleteImpact`                                           |
| `ComputeEntryPermanentDeleteImpactInput` | type     | Input to `computeEntryPermanentDeleteImpact`                                                |
| `DeleteEntryPermanentlyInput`            | type     | Input to `deleteEntryPermanently`                                                           |

### Edit locking

| Export                        | Kind     | Purpose                                                              |
| ----------------------------- | -------- | -------------------------------------------------------------------- |
| `EDIT_LOCK_HEARTBEAT_SECONDS` | constant | `30`: how often a holder should renew                                |
| `EDIT_LOCK_TTL_SECONDS`       | constant | `120`: how long a lock stays live with no renewal                    |
| `isLockLive`                  | function | Whether a lock is still live, given its holder, `lockedAt` and now   |
| `acquireEditLock`             | function | Acquires a lock on one entry locale row                              |
| `renewEditLock`               | function | Renews the current holder's lock                                     |
| `releaseEditLock`             | function | Releases the current holder's lock                                   |
| `takeOverEditLock`            | function | Takes over another user's live lock; needs a permission superset     |
| `EntryLockedError`            | class    | A save/acquire refused by another user's live lock                   |
| `EditLockingDisabledError`    | class    | `acquireEditLock` called against a type with edit locking disabled   |
| `LockTakeoverForbiddenError`  | class    | The caller's permissions are not a superset of the holder's          |
| `LockStateChangedError`       | class    | The lock's state changed between the takeover decision and the write |
| `AcquireEditLockInput`        | type     | Input to `acquireEditLock`                                           |
| `EditLockGrant`               | type     | The result of `acquireEditLock`/`renewEditLock`/`takeOverEditLock`   |
| `RenewEditLockInput`          | type     | Input to `renewEditLock`                                             |
| `ReleaseEditLockInput`        | type     | Input to `releaseEditLock`                                           |
| `TakeOverEditLockInput`       | type     | Input to `takeOverEditLock`                                          |

### Revisions and restore

| Export                       | Kind     | Purpose                                                                                       |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `listRevisions`              | function | Lists one entry's revisions, newest first                                                     |
| `computeRestorePreview`      | function | Previews what restoring a revision would map, drop or leave empty                             |
| `restoreRevision`            | function | Restores a revision's data as a new save, through the same draft-or-live rules as `saveEntry` |
| `RevisionNotFoundError`      | class    | A revision id does not exist, or belongs to another entry                                     |
| `RevisionKind`               | type     | `'save'` or `'publish'`                                                                       |
| `RevisionSummary`            | type     | One entry in `listRevisions`' result                                                          |
| `ListRevisionsInput`         | type     | Input to `listRevisions`                                                                      |
| `RestorePreview`             | type     | The result of `computeRestorePreview`                                                         |
| `ComputeRestorePreviewInput` | type     | Input to `computeRestorePreview`                                                              |
| `RestoreRevisionInput`       | type     | Input to `restoreRevision`                                                                    |

### Revision cap (project settings)

| Export                     | Kind     | Purpose                                                 |
| -------------------------- | -------- | ------------------------------------------------------- |
| `getRevisionCap`           | function | Reads the project-wide `save`-kind revision cap         |
| `computeRevisionCapImpact` | function | Previews how many rows a new cap would prune            |
| `setRevisionCap`           | function | Sets the cap and prunes accordingly, in one transaction |
| `RevisionCapError`         | class    | An invalid (negative or non-integer) cap                |
| `RevisionCapImpact`        | type     | The result of `computeRevisionCapImpact`                |
| `SetRevisionCapInput`      | type     | Input to `setRevisionCap`                               |
| `SetRevisionCapResult`     | type     | The result of `setRevisionCap`                          |

### Translations

| Export                   | Kind     | Purpose                                                 |
| ------------------------ | -------- | ------------------------------------------------------- |
| `createTranslation`      | function | Adds an enabled locale to an existing translation group |
| `TranslationExistsError` | class    | The group already has a row in the requested locale     |
| `CreateTranslationInput` | type     | Input to `createTranslation`                            |

### Field translatable toggle

| Export                            | Kind     | Purpose                                                                       |
| --------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `computeTranslatableChangeImpact` | function | Previews the winner turning a field non-translatable would pick per group     |
| `setFieldTranslatable`            | function | Toggles a field's translatable flag, applying the winner when turning it off  |
| `TranslatableChangeImpactGroup`   | type     | One translation group's preview in `computeTranslatableChangeImpact`'s result |
| `TranslatableChangeImpact`        | type     | The result of `computeTranslatableChangeImpact`                               |
| `SetFieldTranslatableInput`       | type     | Input to `setFieldTranslatable`                                               |

### Singletons

| Export                      | Kind     | Purpose                                                                                            |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `getOrCreateSingleton`      | function | The only creation path for a singleton content type's per-locale record                            |
| `findSingleton`             | function | Reads a singleton type's record in one locale, or `null`                                           |
| `listSingletonRecords`      | function | Lists a singleton type's records across enabled locales                                            |
| `SingletonEntryError`       | class    | `getOrCreateSingleton` on a non-singleton type, or a list/create/translate call on a singleton one |
| `SingletonEntryErrorReason` | type     | `'not-singleton'` or `'singleton-type'`                                                            |
| `GetOrCreateSingletonInput` | type     | Input to `getOrCreateSingleton`                                                                    |
| `FindSingletonInput`        | type     | Input to `findSingleton`                                                                           |
| `ListSingletonRecordsInput` | type     | Input to `listSingletonRecords`                                                                    |

### Boot-time locale check

| Export                | Kind     | Purpose                                                                                                    |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `checkContentLocales` | function | Reports stored entries in a no-longer-enabled locale via `onLocaleRemoved`, never throws for a broken hook |
| `LocaleCheckReport`   | type     | The result of `checkContentLocales`                                                                        |

### Entry SEO

| Export                       | Kind     | Purpose                                                               |
| ---------------------------- | -------- | --------------------------------------------------------------------- |
| `ENTRY_SEO_PROPERTIES`       | constant | The fixed seven-property D-46 SEO set                                 |
| `EMPTY_ENTRY_SEO`            | constant | The complete, defaulted `EntrySeo` for an absent column value         |
| `normalizeEntrySeo`          | function | Turns a null/partial value into a complete `EntrySeo`, never throwing |
| `validateEntrySeo`           | function | Validates an SEO value, collecting every problem before throwing once |
| `EntrySeoValidationError`    | class    | Thrown by `validateEntrySeo` with every problem found                 |
| `SEO_TITLE_MAX_LENGTH`       | constant | Maximum code-point length of `title`                                  |
| `SEO_DESCRIPTION_MAX_LENGTH` | constant | Maximum code-point length of `description`                            |
| `SEO_CANONICAL_MAX_LENGTH`   | constant | Maximum length of `canonicalUrl`                                      |
| `EntrySeoProperty`           | type     | One of `ENTRY_SEO_PROPERTIES`                                         |
| `EntrySeo`                   | type     | The complete, defaulted per-locale SEO value                          |
| `EntrySeoIssueCode`          | type     | One `validateEntrySeo` problem code                                   |
| `EntrySeoIssue`              | type     | One `validateEntrySeo` problem                                        |

### Content type seed

| Export                   | Kind     | Purpose                                                                            |
| ------------------------ | -------- | ---------------------------------------------------------------------------------- |
| `defineContentTypes`     | function | Validates a host's content type seed, typed against every field type's own options |
| `applySeed`              | function | Applies a defined seed additively, tracking applied ids and reporting drift        |
| `ContentTypeSeedError`   | class    | Thrown by `defineContentTypes` with every problem found                            |
| `SEED_ID_PATTERN`        | constant | Allowed shape of a seed item's stable id                                           |
| `SeedIssue`              | type     | One `defineContentTypes` problem                                                   |
| `SeedIssueCode`          | type     | One `defineContentTypes` problem code                                              |
| `SeedContentTypeInput`   | type     | One content type entry in a seed passed to `defineContentTypes`                    |
| `SeedFieldInput`         | type     | One field entry in a seed content type                                             |
| `DefinedContentTypeSeed` | type     | The frozen, normalized result of `defineContentTypes`, input to `applySeed`        |
| `SeedApplicationReport`  | type     | The result of `applySeed`: applied, adopted, drifted and skipped items             |

### References

| Export                            | Kind     | Purpose                                                                          |
| --------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `computeEntryReferenceUsage`      | function | Reports how many entries reference a translation group, and which fields hold it |
| `ReferenceTargetMissingError`     | class    | A reference names a translation group no entry holds                             |
| `ReferenceTypeNotAllowedError`    | class    | A reference's target's content type is not in the field's `allowedTypeKeys`      |
| `EntryReferenceUsageEntry`        | type     | One entry in `computeEntryReferenceUsage`'s result                               |
| `EntryReferenceUsage`             | type     | The result of `computeEntryReferenceUsage`                                       |
| `ComputeEntryReferenceUsageInput` | type     | Input to `computeEntryReferenceUsage`                                            |
