/**
 * Reserved first page-address segments (Phase 7 D-23, carried from Phase 6
 * D-29). The CMS owns `/cms` (editor and admin routes) and `/api` (HTTP
 * endpoints), so a page whose hierarchy path starts with either would be
 * shadowed by the CMS route table or pose as CMS UI. Every write that can set
 * a root slug refuses them (`assertNotReservedFirstSegment`), the slug
 * generator steps over them, and a boot check lists legacy pages that already
 * collide. The boot check follows the keep-data rule used for removed locales:
 * it reports, it never deletes, rewrites or throws.
 *
 * The rule is applied to the hierarchy path's first segment in every locale,
 * not to the public spelling: under the default pattern a non-default locale
 * is served as `/nl/cms`, which would not collide, but the check is kept
 * locale-independent so the answer never depends on the stored URL pattern.
 */
import type { AuditDatabase } from '@plakboek/auth';
import { inArray, sql } from 'drizzle-orm';
import { pages } from './schema.js';
import { reportPagesWarning } from './warnings.js';
import {
  PageUrlPatternError,
  type ParsedPageUrlPattern,
} from './page-url-pattern.js';
import { defaultLocaleFirstSegment } from './public-path.js';

/** First path segments the CMS route table owns. Read by anything that must
 * stay clear of them (a later sitemap exclusion, for one). */
export const RESERVED_PAGE_PATH_SEGMENTS: readonly string[] = Object.freeze([
  'cms',
  'api',
]);

/** Thrown when a write would give a page a reserved first address segment. */
export class ReservedPageSlugError extends Error {
  readonly segment: string;
  readonly path: string;

  constructor(segment: string, path: string) {
    super(
      '@plakboek/pages: The first part of a page address cannot be "cms" or "api". Choose a different address.',
    );
    this.name = 'ReservedPageSlugError';
    this.segment = segment;
    this.path = path;
  }
}

/** The first `/`-separated segment of a hierarchy path. */
function firstSegmentOf(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(0, slash);
}

/** The reserved segment `path` starts with (lower-cased), or `null`. */
function reservedSegmentOf(path: string): string | null {
  const first = firstSegmentOf(path).toLowerCase();
  return RESERVED_PAGE_PATH_SEGMENTS.includes(first) ? first : null;
}

/** `true` when `slug`, placed at the root, would be a reserved first
 * segment. Used by the slug generator, which steps over such a slug. */
export function isReservedPageSlug(slug: string): boolean {
  return reservedSegmentOf(slug) !== null;
}

/**
 * Write-time guard: throws `ReservedPageSlugError` when the first segment of
 * the hierarchy `path` is reserved, compared case-insensitively. Only the
 * first segment counts: `about/cms` and `cmsx` pass. Kept package-internal
 * (not part of the barrel), like the other guards the barrel withholds.
 */
export function assertNotReservedFirstSegment(path: string): void {
  const segment = reservedSegmentOf(path);
  if (segment !== null) {
    throw new ReservedPageSlugError(segment, path);
  }
}

/**
 * Write-time guard for the project-wide URL pattern: throws
 * `PageUrlPatternError` with a `RESERVED_PREFIX` issue when the pattern would
 * give the default locale's pages an address that starts with a reserved
 * segment (`cms/{path}`, `api/{path}`, or `{locale}/cms/{path}`, whose
 * default-locale form has no locale segment). Every page's public address
 * would then sit under a route the CMS owns. The first segment must be the
 * reserved word on its own, so `cms-{path}` passes, and a pattern whose first
 * segment is `{path}` is left to the per-page guard.
 */
export function assertPatternNotReserved(
  pattern: string | ParsedPageUrlPattern,
): void {
  const segment = defaultLocaleFirstSegment(pattern);
  if (!RESERVED_PAGE_PATH_SEGMENTS.includes(segment)) return;
  throw new PageUrlPatternError([
    {
      code: 'RESERVED_PREFIX',
      value: segment,
      message: `the pattern would put every page address under "${segment}", which the CMS owns; start the pattern with something else`,
    },
  ]);
}

/** One stored page whose first path segment is reserved. */
export type ReservedPagePathRow = {
  readonly pageId: string;
  readonly locale: string;
  readonly path: string;
  readonly segment: string;
};

/** Reported once per `ReservedPagePathRow` at boot. */
export type ReservedPagePathEvent = ReservedPagePathRow & {
  readonly occurredAt: Date;
};

/**
 * Lists the pages (any status, trashed included) whose first path segment is
 * reserved: one select. Never deletes or rewrites anything. Call it once at
 * boot alongside `reportReservedPagePaths`.
 */
export async function checkReservedPagePaths(
  db: AuditDatabase,
): Promise<readonly ReservedPagePathRow[]> {
  const rows = await db
    .select({ id: pages.id, locale: pages.locale, path: pages.path })
    .from(pages)
    .where(
      inArray(sql<string>`lower(split_part(${pages.path}, '/', 1))`, [
        ...RESERVED_PAGE_PATH_SEGMENTS,
      ]),
    )
    .orderBy(pages.locale, pages.path);
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        pageId: row.id,
        locale: row.locale,
        path: row.path,
        segment: reservedSegmentOf(row.path) ?? firstSegmentOf(row.path),
      }),
    ),
  );
}

function defaultOnReservedPagePath(event: ReservedPagePathEvent): void {
  // oxlint-disable-next-line no-console -- documented default fallback hook (D-23); a host overrides `onReservedPagePath` to route elsewhere
  console.warn(
    `[@plakboek/pages] Page ${event.path} uses the reserved address segment "${event.segment}". The page was kept; rename it so it can be reached.`,
  );
}

/** The slice of `PagesDeps` the report reads; structural so this module
 * does not import `config.ts`, which imports the event type from here. */
export type ReportReservedPagePathsDeps = {
  readonly hooks?: {
    readonly onReservedPagePath?: (event: ReservedPagePathEvent) => void;
  };
  readonly now?: () => Date;
};

/**
 * Fires `reportPagesWarning(deps.hooks?.onReservedPagePath, ...)` once per
 * row; a broken host hook can never crash boot. Contains no write of any
 * kind: a conflicting page is kept and flagged, never touched.
 */
export function reportReservedPagePaths(
  deps: ReportReservedPagePathsDeps,
  rows: readonly ReservedPagePathRow[],
): void {
  const now = deps.now ?? (() => new Date());
  const occurredAt = now();
  for (const row of rows) {
    reportPagesWarning<ReservedPagePathEvent>(
      deps.hooks?.onReservedPagePath,
      defaultOnReservedPagePath,
      {
        pageId: row.pageId,
        locale: row.locale,
        path: row.path,
        segment: row.segment,
        occurredAt,
      },
    );
  }
}
