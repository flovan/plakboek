/**
 * Materialised page addresses, collision refusal and the audited pattern
 * change (D-22, T-04-43, T-04-45, T-04-46): a published page's
 * `resolved_path` is the project-wide URL pattern resolved against its
 * locale and its materialised hierarchy path, computed once here
 * (`computePageResolvedPath`) and stored on the row so Phase 5's visitor
 * lookup is one indexed read.
 *
 * `computeUrlPatternChangeImpact` and `setPageUrlPattern` mirror
 * `@plakboek/content`'s `routing.ts` shape (`computeUrlPatternChangeImpact`
 * / `setUrlPattern`, 03 D-32): a read-only impact preview, and a write that
 * recomputes that same impact inside its own transaction so the two can
 * never disagree, refuses on any collision before writing anything, records
 * one `page_url_history` row per changed page before the rewrite, and
 * clears every changed row's stale address before setting the new ones so a
 * swap never trips the partial unique index mid-statement.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import {
  parsePageUrlPattern,
  resolvePageUrlPath,
  type ParsedPageUrlPattern,
} from './page-url-pattern.js';
import { recordPageUrlHistory } from './pages.js';
import {
  checkPublicPageAddress,
  DEFAULT_HOME_SLUG,
  type PublicPageAddressCheck,
} from './public-path.js';
import { registerGlobalPurge } from './purge.js';
import { pageEngineSettings, pages } from './schema.js';
import {
  PageEngineSettingsMissingError,
  getPageUrlPattern,
} from './settings.js';

const SETTINGS_ROW_ID = 1;
const RESOLVED_PATH_UNIQUE_CONSTRAINT = 'pages_locale_resolved_path_unique';
const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 3;

export type ComputePageResolvedPathInput = {
  readonly pattern: string | ParsedPageUrlPattern;
  readonly locale: string;
  readonly path: string;
};

/**
 * Computes one page's resolved address: the pattern resolved against its
 * `locale` and its materialised hierarchy `path`. The single place this
 * composition happens -- every caller that needs a page's address (the
 * publish path, `setPageUrlPattern`, and plan 04-13's lifecycle
 * transitions) goes through this function, never `resolvePageUrlPath`
 * directly, so all of them stay in agreement about what a page's address
 * means.
 */
export function computePageResolvedPath(
  input: ComputePageResolvedPathInput,
): string {
  return resolvePageUrlPath(input.pattern, {
    locale: input.locale,
    path: input.path,
  });
}

/** Thrown when a page's resolved address is already held by another page in
 * the same locale (`pages_locale_resolved_path_unique`). `existingPageId` is
 * `null` only when the conflict is discovered through the
 * unique-violation backstop (`pageUrlCollisionFromUniqueViolation`), which
 * cannot name the other row. */
export class PageUrlCollisionError extends Error {
  readonly locale: string;
  readonly resolvedPath: string;
  readonly existingPageId: string | null;

  constructor(
    locale: string,
    resolvedPath: string,
    existingPageId: string | null,
  ) {
    super(
      `@plakboek/pages: resolved path "${resolvedPath}" is already used in locale "${locale}"${
        existingPageId === null ? '' : ` by page "${existingPageId}"`
      }`,
    );
    this.name = 'PageUrlCollisionError';
    this.locale = locale;
    this.resolvedPath = resolvedPath;
    this.existingPageId = existingPageId;
  }
}

/** Thrown by `publishPage` when the page's public path would not lead to the
 * page: the default locale is served without its prefix, so a default-locale
 * page whose path starts with an enabled locale code (`nl/x`, `en/about`) is
 * indistinguishable from, or redirected away from, another address. Nothing is
 * published; rename the page (or its ancestor) to a slug that is not a locale
 * code. */
export class PageAddressUnreachableError extends Error {
  readonly locale: string;
  readonly path: string;
  readonly publicPath: string;
  /** What the page's public path does instead of reaching the page. */
  readonly outcome: 'redirect' | 'other-address' | 'none';

  constructor(
    locale: string,
    path: string,
    publicPath: string,
    outcome: 'redirect' | 'other-address' | 'none',
  ) {
    super(
      `@plakboek/pages: page "${path}" in locale "${locale}" would be served at "${publicPath}", which ${
        outcome === 'redirect'
          ? 'redirects to a different address'
          : outcome === 'other-address'
            ? 'is the address of a different page'
            : 'matches no page'
      } -- rename it to a path whose first segment is not an enabled locale code`,
    );
    this.name = 'PageAddressUnreachableError';
    this.locale = locale;
    this.path = path;
    this.publicPath = publicPath;
    this.outcome = outcome;
  }
}

export type AssertPageAddressReachableInput = {
  readonly pattern: string | ParsedPageUrlPattern;
  readonly locale: string;
  readonly path: string;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
};

/**
 * Throws `PageAddressUnreachableError` when the page's own public path would
 * not resolve back to it. The home slug is the package default
 * (`DEFAULT_HOME_SLUG`); a host's own home slug cannot change the outcome,
 * which depends on the locale-code prefix alone.
 */
export function assertPageAddressReachable(
  input: AssertPageAddressReachableInput,
): void {
  const check: PublicPageAddressCheck = checkPublicPageAddress(input.pattern, {
    locale: input.locale,
    path: input.path,
    locales: input.locales,
    defaultLocale: input.defaultLocale,
    homeSlug: DEFAULT_HOME_SLUG,
  });
  if (check.reachable) return;
  throw new PageAddressUnreachableError(
    input.locale,
    input.path,
    check.publicPath,
    check.outcome,
  );
}

export type AssertPageAddressAvailableInput = {
  readonly locale: string;
  readonly resolvedPath: string;
  readonly excludePageId?: string;
};

/**
 * Throws `PageUrlCollisionError` when another page (excluding
 * `excludePageId` when given) already holds `resolved_path = resolvedPath`
 * in `locale`. An explicit lookup, run before the write that would create
 * the collision, so the caller gets a clear error naming the other page;
 * `pages_locale_resolved_path_unique` is the concurrent-write backstop --
 * see `pageUrlCollisionFromUniqueViolation`.
 */
export async function assertPageAddressAvailable(
  tx: AuditTransaction,
  input: AssertPageAddressAvailableInput,
): Promise<void> {
  const conditions = [
    eq(pages.locale, input.locale),
    eq(pages.resolvedPath, input.resolvedPath),
  ];
  if (input.excludePageId !== undefined) {
    conditions.push(ne(pages.id, input.excludePageId));
  }
  const [row] = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(and(...conditions))
    .limit(1);
  if (row !== undefined) {
    throw new PageUrlCollisionError(input.locale, input.resolvedPath, row.id);
  }
}

/** Walks the `cause` chain looking for a unique-violation on
 * `pages_locale_resolved_path_unique`; returns `false` for any other
 * failure. */
function isResolvedPathUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code: unknown = Reflect.get(current, 'code');
    if (code === UNIQUE_VIOLATION) {
      const constraint: unknown = Reflect.get(current, 'constraint_name');
      return constraint === RESOLVED_PATH_UNIQUE_CONSTRAINT;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Maps a Postgres unique-violation on `pages_locale_resolved_path_unique` to
 * a `PageUrlCollisionError` (`existingPageId: null` -- the violation alone
 * doesn't name the other page), for a caller that writes `resolved_path`
 * directly and races another transaction past `assertPageAddressAvailable`'s
 * check. Returns `null` for any other error.
 */
export function pageUrlCollisionFromUniqueViolation(
  error: unknown,
  input: { readonly locale: string; readonly resolvedPath: string },
): PageUrlCollisionError | null {
  if (!isResolvedPathUniqueViolation(error)) return null;
  return new PageUrlCollisionError(input.locale, input.resolvedPath, null);
}

/** One resolved address a pattern change would give to more than one
 * published page. Grouped by the resolved address alone, not by
 * `(locale, resolvedPath)`: `pages_locale_resolved_path_unique` only
 * enforces uniqueness within a locale, but a pattern lacking `{locale}`
 * (valid for a single-locale install, see `page-url-pattern.ts`) makes two
 * DIFFERENT locales' pages resolve to the identical address on a
 * multi-locale install -- a real ambiguity for whichever visitor requests
 * that address, even though the database's per-locale index would not
 * reject it. This is deliberately stricter than the DB backstop: under any
 * pattern that already includes `{locale}`, two different locales' pages
 * essentially never collide (the locale segment differs), so this check
 * costs nothing in the common case and only bites the one misconfiguration
 * it exists to catch. */
export type PageUrlPatternCollision = {
  readonly resolvedPath: string;
  readonly pageIds: readonly string[];
};

/** Thrown by `setPageUrlPattern` when the new pattern would give two
 * published pages the same resolved address -- listing every colliding
 * address and the page ids that would share it (D-22, mirrors
 * `@plakboek/content`'s `UrlPatternCollisionError`, 03 D-32). Nothing is
 * changed when this is thrown. */
export class PageUrlPatternCollisionError extends Error {
  readonly collisions: readonly PageUrlPatternCollision[];

  constructor(collisions: readonly PageUrlPatternCollision[]) {
    super(
      [
        '@plakboek/pages: URL pattern change would collide:',
        ...collisions.map(
          (collision) =>
            `- "${collision.resolvedPath}": ${collision.pageIds.join(', ')}`,
        ),
      ].join('\n'),
    );
    this.name = 'PageUrlPatternCollisionError';
    this.collisions = collisions;
  }
}

/** One published page's current address next to what it would become under
 * a candidate pattern -- the shared computation `computeUrlPatternChangeImpact`
 * and `setPageUrlPattern` both build on, so a preview and the write are
 * always looking at the exact same data shape. */
type ProspectiveAddress = {
  readonly id: string;
  readonly locale: string;
  readonly translationGroup: string;
  readonly oldResolvedPath: string | null;
  readonly newResolvedPath: string;
};

/** Reads every published page and computes its resolved address under
 * `parsedNewPattern`, without writing anything. Accepts a plain database
 * handle or an open transaction, so `computeUrlPatternChangeImpact` can run
 * standalone for a caller previewing a change, and `setPageUrlPattern` can
 * call it again inside its own transaction. */
async function computeProspectiveAddresses(
  db: AuditDatabase,
  parsedNewPattern: ParsedPageUrlPattern,
): Promise<readonly ProspectiveAddress[]> {
  const publishedRows = await db
    .select({
      id: pages.id,
      locale: pages.locale,
      translationGroup: pages.translationGroup,
      path: pages.path,
      resolvedPath: pages.resolvedPath,
    })
    .from(pages)
    .where(eq(pages.status, 'published'));

  return publishedRows.map((row) => ({
    id: row.id,
    locale: row.locale,
    translationGroup: row.translationGroup,
    oldResolvedPath: row.resolvedPath,
    newResolvedPath: computePageResolvedPath({
      pattern: parsedNewPattern,
      locale: row.locale,
      path: row.path,
    }),
  }));
}

/** Groups `addresses` by their prospective resolved path, reporting every
 * group of two or more as a collision (see `PageUrlPatternCollision`'s own
 * comment for why the grouping key is the address alone). */
function findUrlPatternCollisions(
  addresses: readonly ProspectiveAddress[],
): readonly PageUrlPatternCollision[] {
  const pageIdsByResolvedPath = new Map<string, string[]>();
  for (const address of addresses) {
    const existing = pageIdsByResolvedPath.get(address.newResolvedPath);
    if (existing === undefined) {
      pageIdsByResolvedPath.set(address.newResolvedPath, [address.id]);
    } else {
      existing.push(address.id);
    }
  }

  const collisions: PageUrlPatternCollision[] = [];
  for (const [resolvedPath, pageIds] of pageIdsByResolvedPath) {
    if (pageIds.length > 1) {
      collisions.push({ resolvedPath, pageIds });
    }
  }
  return collisions;
}

export type ComputeUrlPatternChangeImpactInput = {
  readonly newPattern: string;
};

export type PageUrlPatternChangeImpact = {
  readonly currentPattern: string;
  readonly newPattern: string;
  readonly changedCount: number;
  readonly unchangedCount: number;
  readonly collisions: readonly PageUrlPatternCollision[];
};

/**
 * Reports what changing the project-wide page URL pattern to
 * `input.newPattern` would do to every currently published page (D-22, 03
 * D-32): how many pages' addresses would change, how many would stay the
 * same, and every collision the change would cause. Throws
 * `PageUrlPatternError` when `newPattern` itself is invalid. Read-only and
 * takes a plain `db`, so it runs standalone for a caller previewing a
 * change, and again inside `setPageUrlPattern`'s own transaction (passing
 * its `tx`) so the write can never drift from what was previewed.
 */
export async function computeUrlPatternChangeImpact(
  db: AuditDatabase,
  input: ComputeUrlPatternChangeImpactInput,
): Promise<PageUrlPatternChangeImpact> {
  const currentPattern = await getPageUrlPattern(db);
  const parsedNewPattern = parsePageUrlPattern(input.newPattern);
  const addresses = await computeProspectiveAddresses(db, parsedNewPattern);

  let changedCount = 0;
  let unchangedCount = 0;
  for (const address of addresses) {
    if (address.newResolvedPath !== address.oldResolvedPath) {
      changedCount += 1;
    } else {
      unchangedCount += 1;
    }
  }

  return {
    currentPattern,
    newPattern: input.newPattern,
    changedCount,
    unchangedCount,
    collisions: findUrlPatternCollisions(addresses),
  };
}

export type SetPageUrlPatternInput = {
  readonly newPattern: string;
};

/**
 * Changes the project-wide page URL pattern (D-22), for a role holding
 * `pages:publish` -- changing it changes every published page's address.
 * Locks the settings row (`FOR UPDATE`) for the duration of the change, so
 * two concurrent pattern changes serialise. Recomputes the impact inside
 * this same transaction (`computeUrlPatternChangeImpact`, so nothing can
 * drift between a caller's earlier preview and this write -- a page
 * published between the two is included, not missed) and refuses with
 * `PageUrlPatternCollisionError` the moment it finds any collision,
 * changing nothing.
 *
 * On success: one `page_url_history` row (reason `pattern_changed`) is
 * appended per changed page, before the rewrite, carrying its *old*
 * address; every changed page's `resolved_path` is cleared in one batched
 * statement, then set to its new value in a second batched
 * `UPDATE ... FROM (VALUES ...)` statement -- so two pages swapping
 * addresses under the new pattern never trip the unique index mid-update,
 * mirroring `movePage`/`renamePage`'s own subtree rewrite (`pages.ts`).
 * Setting the pattern to its current value is a no-op write: no page
 * changes, no history is recorded, but the audited mutation still records
 * one row. Runs through `deps.recorder.run` (`pages:publish` /
 * `page.set-url-pattern`).
 *
 * Deliberately lock-exempt (T-04-58): this rewrites `resolved_path` on
 * every published page, project-wide -- not a single page's edit. It never
 * calls `assertPageWritable`. A per-page edit lock blocking a project-wide
 * URL-pattern change would be impractical; the `pages:publish` permission
 * check and the `recorder.run` audit trail are this operation's own guard.
 */
export async function setPageUrlPattern(
  deps: PagesDeps,
  actor: AuditActor,
  input: SetPageUrlPatternInput,
): Promise<PageUrlPatternChangeImpact> {
  const now = deps.now ?? (() => new Date());
  const currentPattern = await getPageUrlPattern(deps.db);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:publish',
      action: 'page.set-url-pattern',
      entityType: 'page_engine_settings',
      entityId: String(SETTINGS_ROW_ID),
      before: { urlPattern: currentPattern },
    },
    async (tx, context) => {
      const [settingsRow] = await tx
        .select({ urlPattern: pageEngineSettings.urlPattern })
        .from(pageEngineSettings)
        .where(eq(pageEngineSettings.id, SETTINGS_ROW_ID))
        .for('update');
      if (settingsRow === undefined) {
        throw new PageEngineSettingsMissingError();
      }

      // Never trust a caller's earlier preview: recompute the impact
      // against the state this transaction just locked.
      const impact = await computeUrlPatternChangeImpact(tx, {
        newPattern: input.newPattern,
      });
      if (impact.collisions.length > 0) {
        throw new PageUrlPatternCollisionError(impact.collisions);
      }

      const parsedNewPattern = parsePageUrlPattern(input.newPattern);
      const addresses = await computeProspectiveAddresses(tx, parsedNewPattern);
      const changed = addresses.filter(
        (address) => address.newResolvedPath !== address.oldResolvedPath,
      );

      const updatedAt = now();
      for (const address of changed) {
        if (address.oldResolvedPath === null) continue;
        await recordPageUrlHistory(tx, {
          pageId: address.id,
          translationGroup: address.translationGroup,
          locale: address.locale,
          oldPath: address.oldResolvedPath,
          reason: 'pattern_changed',
          changedAt: updatedAt,
        });
      }

      if (changed.length > 0) {
        // Two statements -- clear every changed page's address first, then
        // set the new ones -- so a swap under the new pattern never trips
        // the unique index mid-update.
        await tx
          .update(pages)
          .set({ resolvedPath: null })
          .where(
            inArray(
              pages.id,
              changed.map((address) => address.id),
            ),
          );

        const valuesClause = sql.join(
          changed.map(
            (address) =>
              sql`(${address.id}::uuid, ${address.newResolvedPath}::text)`,
          ),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE pages SET resolved_path = v.new_resolved_path
          FROM (VALUES ${valuesClause}) AS v(id, new_resolved_path)
          WHERE pages.id = v.id
        `);
      }

      await tx
        .update(pageEngineSettings)
        .set({ urlPattern: input.newPattern, updatedAt })
        .where(eq(pageEngineSettings.id, SETTINGS_ROW_ID));

      // A project-wide address rewrite changes every public URL; a call that
      // stores the same value changes nothing.
      if (input.newPattern !== settingsRow.urlPattern) {
        registerGlobalPurge(deps, context);
      }

      const result: PageUrlPatternChangeImpact = {
        currentPattern: settingsRow.urlPattern,
        newPattern: input.newPattern,
        changedCount: changed.length,
        unchangedCount: addresses.length - changed.length,
        collisions: [],
      };
      return { result, after: result };
    },
  );
}
