/**
 * Starting a page translation group in another locale (D-21, D-36, mirrors
 * `@plakboek/content`'s `translations.ts`): any enabled locale can start a
 * group -- `createPage` already does that -- and `createPageTranslation`
 * adds another enabled locale to an existing group. No block rows are ever
 * copied: D-34 makes each `(owner, locale)` block tree independent, and
 * copying a structure would create the cross-locale block identity D-34
 * explicitly declines to create.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { and, asc, eq } from 'drizzle-orm';
import type { PagesConfig, PagesDeps } from './config.js';
import {
  assertPageSlugAvailable,
  composePagePath,
  generateUniquePageSlug,
} from './page-slug.js';
import {
  LocaleNotEnabledError,
  PageNotFoundError,
  toPageRecord,
} from './pages.js';
import { pages } from './schema.js';
import type { PageRecord } from './types.js';

const GROUP_LOCALE_UNIQUE_CONSTRAINT = 'pages_group_locale_unique';
const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 3;

/** Walks the `cause` chain looking for a unique-violation on
 * `constraintName`; returns `false` for any other failure. Mirrors
 * `@plakboek/content`'s `translations.ts` helper of the same shape. */
function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code: unknown = Reflect.get(current, 'code');
    const constraint: unknown = Reflect.get(current, 'constraint_name');
    if (code === UNIQUE_VIOLATION && constraint === constraintName) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Thrown by `createPageTranslation` when `input.locale` already has a page
 * in `sourceEntryId`'s translation group. */
export class PageTranslationExistsError extends Error {
  readonly translationGroup: string;
  readonly locale: string;

  constructor(translationGroup: string, locale: string) {
    super(
      `@plakboek/pages: translation group "${translationGroup}" already has a page for locale "${locale}"`,
    );
    this.name = 'PageTranslationExistsError';
    this.translationGroup = translationGroup;
    this.locale = locale;
  }
}

export type CreatePageTranslationInput = {
  readonly pageId: string;
  readonly locale: string;
  readonly title?: string;
  readonly slug?: string;
};

/**
 * Adds `input.locale` to `input.pageId`'s translation group (D-21, D-36).
 * Refuses a disabled locale before the audited mutation opens
 * (`LocaleNotEnabledError`); otherwise, through `deps.recorder.run`
 * (`pages:create` / `page.translate`): loads the source page `FOR SHARE`
 * (`PageNotFoundError` when it doesn't exist), refuses an existing row for
 * `input.locale` in the same group (`PageTranslationExistsError` -- the
 * `pages_group_locale_unique` constraint is the concurrent-write backstop,
 * and a 23505 on it maps to the same error), then inserts a new row sharing
 * `translationGroup`.
 *
 * The new page's slug is resolved through `page-slug.ts`'s generated/manual
 * split, exactly like `createPage`. Its `path` is composed against the
 * source page's parent's sibling in `input.locale` when one exists (the
 * source page has a parent, and that parent's translation group already
 * holds a row in the target locale) -- otherwise the translation is placed
 * at the root of `input.locale`, the chosen rule for every other case
 * (source page has no parent, or its parent has no sibling in the target
 * locale yet). No block rows are copied: the new page's tree starts empty.
 */
export async function createPageTranslation(
  deps: PagesDeps,
  actor: AuditActor,
  input: CreatePageTranslationInput,
): Promise<PageRecord> {
  if (!deps.config.content.locales.includes(input.locale)) {
    throw new LocaleNotEnabledError(input.locale);
  }
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:create',
      action: 'page.translate',
      entityType: 'page',
    },
    async (tx: AuditTransaction) => {
      const [sourceRow] = await tx
        .select()
        .from(pages)
        .where(eq(pages.id, input.pageId))
        .for('share');
      if (sourceRow === undefined) {
        throw new PageNotFoundError(input.pageId);
      }
      const source = toPageRecord(sourceRow);

      const [existing] = await tx
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(
            eq(pages.translationGroup, source.translationGroup),
            eq(pages.locale, input.locale),
          ),
        )
        .limit(1);
      if (existing !== undefined) {
        throw new PageTranslationExistsError(
          source.translationGroup,
          input.locale,
        );
      }

      let targetParentPageId: string | null = null;
      let targetParentPath: string | null = null;
      if (source.parentPageId !== null) {
        const [sourceParent] = await tx
          .select({ translationGroup: pages.translationGroup })
          .from(pages)
          .where(eq(pages.id, source.parentPageId))
          .for('share');
        if (sourceParent !== undefined) {
          const [targetSibling] = await tx
            .select({ id: pages.id, path: pages.path })
            .from(pages)
            .where(
              and(
                eq(pages.translationGroup, sourceParent.translationGroup),
                eq(pages.locale, input.locale),
              ),
            )
            .limit(1);
          if (targetSibling !== undefined) {
            targetParentPageId = targetSibling.id;
            targetParentPath = targetSibling.path;
          }
        }
      }

      const title = input.title ?? source.title;
      let slug: string;
      let slugSource: 'generated' | 'manual';
      if (input.slug !== undefined) {
        slugSource = 'manual';
        await assertPageSlugAvailable(tx, {
          locale: input.locale,
          slug: input.slug,
          parentPath: targetParentPath,
          parentPageId: targetParentPageId,
        });
        slug = input.slug;
      } else {
        slugSource = 'generated';
        slug = await generateUniquePageSlug(tx, {
          locale: input.locale,
          parentPath: targetParentPath,
          parentPageId: targetParentPageId,
          base: title,
        });
      }
      const path = composePagePath(targetParentPath, slug);
      const createdAt = now();

      try {
        const [row] = await tx
          .insert(pages)
          .values({
            translationGroup: source.translationGroup,
            locale: input.locale,
            parentPageId: targetParentPageId,
            slug,
            slugSource,
            path,
            title,
            status: 'draft',
            version: 1,
            createdBy: actor.userId,
            updatedBy: actor.userId,
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        if (row === undefined) {
          throw new Error(
            '@plakboek/pages: page translation insert returned no row',
          );
        }
        const record = toPageRecord(row);
        return { result: record, after: record };
      } catch (error) {
        if (isUniqueViolationOn(error, GROUP_LOCALE_UNIQUE_CONSTRAINT)) {
          throw new PageTranslationExistsError(
            source.translationGroup,
            input.locale,
          );
        }
        throw error;
      }
    },
  );
}

export type ListPageTranslationsInput = {
  readonly translationGroup: string;
};

/**
 * Reads every enabled-locale row of `input.translationGroup`, ordered by
 * locale, excluding a locale removed from `config.content.locales` (D-37) --
 * mirrors `@plakboek/content`'s `findTranslations` exclusion. Not
 * permission-gated (see `getPage`).
 */
export async function listPageTranslations(
  db: AuditDatabase,
  config: PagesConfig,
  input: ListPageTranslationsInput,
): Promise<readonly PageRecord[]> {
  const rows = await db
    .select()
    .from(pages)
    .where(eq(pages.translationGroup, input.translationGroup))
    .orderBy(asc(pages.locale));
  return rows
    .filter((row) => config.content.locales.includes(row.locale))
    .map(toPageRecord);
}
