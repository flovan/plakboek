/**
 * The text environment of one editor-side render: the host's text theme, the
 * mode the render is for and every page link of the forest resolved in one
 * batch, since the renderer is synchronous.
 *
 * Unlike a visitor page, the editor frame and its fragments resolve a link
 * to a page whether or not that page is live: an editor may link to a page
 * that is still a draft. Only the published view shown to a viewer resolves
 * live targets alone, so it never exposes an unpublished address.
 */
import {
  resolvePageLinkPaths,
  type PagesConfig,
  type PagesDeps,
} from '@plakboek/pages';
import {
  createTextEnvironment,
  defineTextTheme,
  type TextEnvironment,
  type TextEnvironmentMode,
  type TextThemeDefinition,
} from '@plakboek/render';
import { collectPageLinkIds, type RenderHooks } from '@plakboek/render/server';

export type TextEnvironmentInput = {
  readonly db: PagesDeps['db'];
  readonly config: Pick<PagesConfig, 'blocks' | 'content'>;
  readonly homeSlug: string;
  /** The host's theme; the stock theme when none was set. */
  readonly textTheme: TextThemeDefinition | undefined;
  /** The forest about to be rendered. */
  readonly blocks: Parameters<typeof collectPageLinkIds>[0];
  /** `'edit'` for the live frame and fragments, `'visitor'` for markup an
   * editor sees exactly as a visitor would. */
  readonly mode: TextEnvironmentMode;
  /** Whether a link to a page that is not live stays unresolved. */
  readonly liveOnly: boolean;
  readonly hooks?: RenderHooks | undefined;
};

/** The environment to render `blocks` under; one query at most, none when no
 * block holds a page link. */
export async function textEnvironmentFor(
  input: TextEnvironmentInput,
): Promise<TextEnvironment> {
  const definitions = new Map(
    input.config.blocks.map((block) => [block.key, block]),
  );
  const pageIds = collectPageLinkIds(input.blocks, definitions);
  const paths =
    pageIds.length === 0
      ? new Map<string, string>()
      : await resolvePageLinkPaths(input.db, {
          pageIds,
          defaultLocale: input.config.content.defaultLocale,
          homeSlug: input.homeSlug,
          liveOnly: input.liveOnly,
        });
  return createTextEnvironment({
    definition: input.textTheme ?? defineTextTheme(),
    mode: input.mode,
    resolvePage: (id) => paths.get(id) ?? null,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
}
