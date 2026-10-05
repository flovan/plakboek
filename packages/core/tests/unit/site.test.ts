import type { DocumentInput } from '@plakboek/render';
import { describe, expect, it, vi } from 'vitest';
import { createSiteHooks, type SiteHooksConfig } from '../../src/site.js';
import type { SiteContext, SiteModule } from '../../src/types.js';

const config: SiteHooksConfig = {
  siteName: 'Test site',
  content: { locales: ['en', 'nl'], defaultLocale: 'en' },
  menus: {
    main: [
      { label: { en: 'Home', nl: 'Start' }, href: '/' },
      { label: 'About', href: '/about' },
    ],
  },
};

const input = (publicPath: string, lang = 'en'): DocumentInput => ({
  head: {
    lang,
    title: 'T',
    description: null,
    canonicalUrl: null,
    robots: null,
    imageUrl: null,
  },
  body: '<main>x</main>',
  publicPath,
});

function recordingSite(): {
  site: SiteModule;
  documents: { input: DocumentInput; context: SiteContext }[];
  notFounds: { request: Request; context: SiteContext }[];
} {
  const documents: { input: DocumentInput; context: SiteContext }[] = [];
  const notFounds: { request: Request; context: SiteContext }[] = [];
  return {
    documents,
    notFounds,
    site: {
      renderDocument(documentInput, context) {
        documents.push({ input: documentInput, context });
        return '<html>doc</html>';
      },
      renderNotFound(request, context) {
        notFounds.push({ request, context });
        return '<html>missing</html>';
      },
    },
  };
}

describe('createSiteHooks renderDocument', () => {
  it('passes the input through with a context built from the page', async () => {
    const { site, documents } = recordingSite();
    const hooks = createSiteHooks({ config, site });
    const given = input('/about', 'nl');

    const html = await hooks.renderDocument(given);

    expect(html).toBe('<html>doc</html>');
    expect(documents[0]?.input).toBe(given);
    expect(documents[0]?.context).toMatchObject({
      siteName: 'Test site',
      locale: 'nl',
      defaultLocale: 'en',
      publicPath: '/about',
    });
  });

  it('marks the item matching the current path as current', async () => {
    const { site, documents } = recordingSite();
    const hooks = createSiteHooks({ config, site });

    await hooks.renderDocument(input('/'));
    expect(await documents[0]?.context.getMenu('main')).toEqual([
      { label: 'Home', href: '/', current: true },
      { label: 'About', href: '/about', current: false },
    ]);

    await hooks.renderDocument(input('/about'));
    expect(await documents[1]?.context.getMenu('main')).toEqual([
      { label: 'Home', href: '/', current: false },
      { label: 'About', href: '/about', current: true },
    ]);
  });

  it('resolves the label for the page locale', async () => {
    const { site, documents } = recordingSite();
    const hooks = createSiteHooks({ config, site });

    await hooks.renderDocument(input('/nl', 'nl'));

    const menu = await documents[0]?.context.getMenu('main');
    expect(menu?.[0]?.label).toBe('Start');
  });

  it('resolves an undeclared menu to an empty list', async () => {
    const { site, documents } = recordingSite();
    const hooks = createSiteHooks({ config, site });

    await hooks.renderDocument(input('/'));

    expect(await documents[0]?.context.getMenu('footer')).toEqual([]);
  });

  it('returns a promise from getMenu so a database-backed menu fits behind it', async () => {
    const { site, documents } = recordingSite();
    const hooks = createSiteHooks({ config, site });
    await hooks.renderDocument(input('/'));
    expect(documents[0]?.context.getMenu('main')).toBeInstanceOf(Promise);
  });
});

describe('createSiteHooks notFound', () => {
  it('uses the locale from a configured path prefix and no public path', async () => {
    const { site, notFounds } = recordingSite();
    const hooks = createSiteHooks({ config, site });
    const request = new Request('http://localhost/nl/onbekend');

    const response = await hooks.notFound?.(request);

    expect(notFounds[0]?.request).toBe(request);
    expect(notFounds[0]?.context.locale).toBe('nl');
    expect(notFounds[0]?.context.publicPath).toBeNull();
    expect(response?.headers.get('Content-Type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(await response?.text()).toBe('<html>missing</html>');
  });

  it('falls back to the default locale for an unprefixed path', async () => {
    const { site, notFounds } = recordingSite();
    const hooks = createSiteHooks({ config, site });

    await hooks.notFound?.(new Request('http://localhost/nope'));

    expect(notFounds[0]?.context.locale).toBe('en');
  });

  it('does not treat an unknown first segment as a locale', async () => {
    const { site, notFounds } = recordingSite();
    const hooks = createSiteHooks({ config, site });

    await hooks.notFound?.(new Request('http://localhost/fr/page'));

    expect(notFounds[0]?.context.locale).toBe('en');
  });

  it('supplies no notFound hook when the site module has no renderNotFound', () => {
    const site: SiteModule = { renderDocument: () => '' };
    const hooks = createSiteHooks({ config, site });
    expect(hooks.notFound).toBeUndefined();
    expect(hooks.renderError).toBeUndefined();
  });

  it('lets a throwing renderNotFound reject so the handler falls back to its default', async () => {
    const renderNotFound = vi.fn(() => {
      throw new Error('boom');
    });
    const hooks = createSiteHooks({
      config,
      site: { renderDocument: () => '', renderNotFound },
    });
    await expect(
      hooks.notFound?.(new Request('http://localhost/x')),
    ).rejects.toThrow('boom');
  });
});

describe('createSiteHooks renderError', () => {
  it('renders the host error page as html with the path locale', async () => {
    const renderError = vi.fn((_request: Request, context: SiteContext) =>
      Promise.resolve(`<p>${context.locale}</p>`),
    );
    const hooks = createSiteHooks({
      config,
      site: { renderDocument: () => '', renderError },
    });

    const response = await hooks.renderError?.(
      new Request('http://localhost/nl/kapot'),
    );

    expect(response?.headers.get('Content-Type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(await response?.text()).toBe('<p>nl</p>');
  });
});
