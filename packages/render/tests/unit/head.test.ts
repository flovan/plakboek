import { describe, expect, it } from 'vitest';
import {
  buildPageHead,
  renderHeadHtml,
  type PageHeadInput,
  type PageSeoInput,
} from '../../src/head.js';

const EMPTY_SEO: PageSeoInput = {
  title: null,
  description: null,
  imageAssetId: null,
  canonicalUrl: null,
  noindex: false,
  nofollow: false,
};

function input(
  overrides: Partial<Omit<PageHeadInput, 'seo'>> & {
    seo?: Partial<PageSeoInput>;
  } = {},
): PageHeadInput {
  const { seo, ...rest } = overrides;
  return {
    lang: 'en',
    pageTitle: 'About us',
    publicPath: '/en/about',
    ...rest,
    seo: { ...EMPTY_SEO, ...seo },
  };
}

describe('buildPageHead title and description', () => {
  it('prefers the stored SEO title', () => {
    expect(buildPageHead(input({ seo: { title: 'Search title' } })).title).toBe(
      'Search title',
    );
  });

  it('falls back to the page title when the SEO title is null', () => {
    expect(buildPageHead(input()).title).toBe('About us');
  });

  it('emits the description only when non-null', () => {
    expect(buildPageHead(input()).description).toBeNull();
    expect(
      buildPageHead(input({ seo: { description: 'About the team' } }))
        .description,
    ).toBe('About the team');
  });

  it('carries the language through', () => {
    expect(buildPageHead(input({ lang: 'nl' })).lang).toBe('nl');
  });
});

describe('buildPageHead canonical', () => {
  it('prefers the stored override', () => {
    const head = buildPageHead(
      input({
        siteUrl: 'https://example.test',
        seo: { canonicalUrl: 'https://other.test/about' },
      }),
    );
    expect(head.canonicalUrl).toBe('https://other.test/about');
  });

  it('builds it from the configured site URL and the public path', () => {
    expect(
      buildPageHead(input({ siteUrl: 'https://example.test' })).canonicalUrl,
    ).toBe('https://example.test/en/about');
  });

  it('strips trailing slashes from the site URL and adds a missing leading slash', () => {
    expect(
      buildPageHead(
        input({ siteUrl: 'https://example.test//', publicPath: 'en/about' }),
      ).canonicalUrl,
    ).toBe('https://example.test/en/about');
  });

  it('keeps a configured base path', () => {
    expect(
      buildPageHead(input({ siteUrl: 'https://example.test/site/' }))
        .canonicalUrl,
    ).toBe('https://example.test/site/en/about');
  });

  it('emits no canonical when neither an override nor a site URL exists', () => {
    const head = buildPageHead(input());
    expect(head.canonicalUrl).toBeNull();
    expect(renderHeadHtml(head)).not.toContain('rel="canonical"');
  });

  it('ignores a site URL that is not an absolute http(s) URL', () => {
    expect(
      buildPageHead(input({ siteUrl: 'javascript:alert(1)' })).canonicalUrl,
    ).toBeNull();
    expect(
      buildPageHead(input({ siteUrl: '/relative' })).canonicalUrl,
    ).toBeNull();
  });
});

describe('buildPageHead robots', () => {
  it('joins noindex and nofollow', () => {
    expect(
      buildPageHead(input({ seo: { noindex: true, nofollow: true } })).robots,
    ).toBe('noindex, nofollow');
  });

  it('emits either word alone', () => {
    expect(buildPageHead(input({ seo: { noindex: true } })).robots).toBe(
      'noindex',
    );
    expect(buildPageHead(input({ seo: { nofollow: true } })).robots).toBe(
      'nofollow',
    );
  });

  it('emits no robots meta when neither flag is set', () => {
    const head = buildPageHead(input());
    expect(head.robots).toBeNull();
    expect(renderHeadHtml(head)).not.toContain('name="robots"');
  });
});

describe('buildPageHead image', () => {
  it('resolves the asset id through the injected resolver', () => {
    const head = buildPageHead(
      input({
        seo: { imageAssetId: 'asset-1' },
        resolveAssetUrl: (id) => `https://cdn.test/${id}.jpg`,
      }),
    );
    expect(head.imageUrl).toBe('https://cdn.test/asset-1.jpg');
  });

  it('emits nothing without a resolver, with a null return, or without an asset id', () => {
    expect(
      buildPageHead(input({ seo: { imageAssetId: 'asset-1' } })).imageUrl,
    ).toBeNull();
    expect(
      buildPageHead(
        input({
          seo: { imageAssetId: 'asset-1' },
          resolveAssetUrl: () => null,
        }),
      ).imageUrl,
    ).toBeNull();
    expect(
      buildPageHead(input({ resolveAssetUrl: () => 'https://cdn.test/x.jpg' }))
        .imageUrl,
    ).toBeNull();
  });
});

describe('renderHeadHtml', () => {
  it('renders every populated element in order', () => {
    const markup = renderHeadHtml({
      lang: 'en',
      title: 'About us',
      description: 'The team',
      canonicalUrl: 'https://example.test/en/about?a=1&b=2',
      robots: 'noindex',
      imageUrl: 'https://cdn.test/x.jpg',
    });
    expect(markup).toBe(
      '<title>About us</title>' +
        '<meta name="description" content="The team"/>' +
        '<link rel="canonical" href="https://example.test/en/about?a=1&amp;b=2"/>' +
        '<meta name="robots" content="noindex"/>' +
        '<meta property="og:image" content="https://cdn.test/x.jpg"/>',
    );
  });

  it('omits every element whose value is null', () => {
    expect(
      renderHeadHtml({
        lang: 'en',
        title: 'Only title',
        description: null,
        canonicalUrl: null,
        robots: null,
        imageUrl: null,
      }),
    ).toBe('<title>Only title</title>');
  });

  it('escapes hostile strings so no markup is produced', () => {
    const markup = renderHeadHtml(
      buildPageHead(
        input({
          pageTitle: '</title><script>alert(1)</script>',
          seo: {
            description: '"><img src=x onerror=alert(1)>',
            canonicalUrl: 'https://example.test/"><script>x</script>',
          },
          resolveAssetUrl: () => 'x"><script>y</script>',
        }),
      ),
    );
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;/title&gt;&lt;script&gt;');
    expect(markup).toContain('&quot;&gt;&lt;img');
  });
});
