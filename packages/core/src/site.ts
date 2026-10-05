import type { RenderDocument } from '@plakboek/render';
import type { PlakboekConfig, SiteModule } from './types.js';

export type SiteHooksConfig = Pick<PlakboekConfig, 'siteName' | 'menus'> & {
  readonly content: Pick<
    PlakboekConfig['content'],
    'locales' | 'defaultLocale'
  >;
};

export type SiteHooks = {
  readonly renderDocument: RenderDocument;
  readonly notFound?: (request: Request) => Promise<Response>;
  readonly renderError?: (request: Request) => Promise<Response>;
};

export function createSiteHooks(_options: {
  readonly config: SiteHooksConfig;
  readonly site: SiteModule;
}): SiteHooks {
  return { renderDocument: () => '' };
}
