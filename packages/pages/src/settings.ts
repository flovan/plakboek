/**
 * The single-row, project-wide page engine settings (D-40): the page
 * edit-lock toggle and the URL pattern, seeded by `0003_page_block_engine`'s
 * migration, read here and never per page or per content type. Mirrors
 * `@plakboek/content`'s `settings.ts` read shape.
 *
 * This module ships the reads plus `setPageEditLocking`, the page-lock
 * toggle's audited writer (plan 04-14). The URL pattern's audited writer
 * (`setPageUrlPattern`) lives in `page-routing.ts`, which locks this same
 * row `FOR UPDATE` directly rather than through a helper here, since it
 * needs to hold the lock across its own multi-step transaction --
 * `setPageEditLocking` does the same for the same reason.
 */
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { eq } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import { pageEngineSettings } from './schema.js';

const SETTINGS_ROW_ID = 1;

export type PageEngineSettings = {
  readonly pageEditLocking: boolean;
  readonly urlPattern: string;
  readonly updatedAt: Date;
};

/** Thrown by `getPageEngineSettings` when the single seeded row is absent --
 * a database that skipped (or somehow lost) `0003_page_block_engine`'s seed
 * fails loudly here rather than silently falling back to a default that
 * could disagree with what a later write stores (T-04-48). */
export class PageEngineSettingsMissingError extends Error {
  constructor() {
    super(
      '[@plakboek/pages] page_engine_settings has no row -- did the 0003_page_block_engine migration seed run?',
    );
    this.name = 'PageEngineSettingsMissingError';
  }
}

/**
 * Reads the single project-wide page engine settings row (`id = 1`).
 * Accepts a plain database handle or an open transaction (`AuditDatabase`
 * covers both, matching every other read in this package). Throws
 * `PageEngineSettingsMissingError` rather than defaulting when the row is
 * missing.
 */
export async function getPageEngineSettings(
  db: AuditDatabase,
): Promise<PageEngineSettings> {
  const [row] = await db
    .select({
      pageEditLocking: pageEngineSettings.pageEditLocking,
      urlPattern: pageEngineSettings.urlPattern,
      updatedAt: pageEngineSettings.updatedAt,
    })
    .from(pageEngineSettings)
    .where(eq(pageEngineSettings.id, SETTINGS_ROW_ID))
    .limit(1);
  if (row === undefined) {
    throw new PageEngineSettingsMissingError();
  }
  return row;
}

/** Reads just the stored page URL pattern -- the value every `resolved_path`
 * materialisation and every pattern-change impact report is computed
 * against. */
export async function getPageUrlPattern(db: AuditDatabase): Promise<string> {
  const settings = await getPageEngineSettings(db);
  return settings.urlPattern;
}

/** Reads just the project-wide page edit-lock toggle (D-40) -- the value
 * `locks.ts`'s `assertPageWritable` and every write path in this package
 * treat as a no-op when `false`, whatever a fixture or a prior state left
 * in a row's own lock columns. */
export async function getPageEditLocking(db: AuditDatabase): Promise<boolean> {
  const settings = await getPageEngineSettings(db);
  return settings.pageEditLocking;
}

export type SetPageEditLockingInput = {
  readonly enabled: boolean;
};

export type SetPageEditLockingResult = {
  readonly previous: boolean;
  readonly current: boolean;
};

/**
 * Sets the project-wide page edit-lock toggle (D-40), for a role holding
 * `pages:publish` -- the same permission `setPageUrlPattern` (`page-
 * routing.ts`) uses for the other half of this single-row settings
 * surface. Locks the settings row `FOR UPDATE` for the duration of the
 * change, so two concurrent toggles serialise rather than lose one
 * writer's update; there is exactly one flag, so there is nothing to
 * recompute inside the transaction the way a pattern change recomputes its
 * impact. Runs through `deps.recorder.run` (`pages:publish` /
 * `page.set-edit-locking`); `after` carries `{ previous, current }`.
 */
export async function setPageEditLocking(
  deps: PagesDeps,
  actor: AuditActor,
  input: SetPageEditLockingInput,
): Promise<SetPageEditLockingResult> {
  const now = deps.now ?? (() => new Date());
  const previous = await getPageEditLocking(deps.db);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:publish',
      action: 'page.set-edit-locking',
      entityType: 'page_engine_settings',
      entityId: String(SETTINGS_ROW_ID),
      before: { pageEditLocking: previous },
    },
    async (tx) => {
      const [settingsRow] = await tx
        .select({ pageEditLocking: pageEngineSettings.pageEditLocking })
        .from(pageEngineSettings)
        .where(eq(pageEngineSettings.id, SETTINGS_ROW_ID))
        .for('update');
      if (settingsRow === undefined) {
        throw new PageEngineSettingsMissingError();
      }

      await tx
        .update(pageEngineSettings)
        .set({ pageEditLocking: input.enabled, updatedAt: now() })
        .where(eq(pageEngineSettings.id, SETTINGS_ROW_ID));

      const result: SetPageEditLockingResult = {
        previous: settingsRow.pageEditLocking,
        current: input.enabled,
      };
      return { result, after: result };
    },
  );
}
