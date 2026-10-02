/**
 * The SEO head emitter (D-13). `buildPageHead` turns a page's stored SEO set
 * into a plain `PageHead`; `renderHeadHtml` renders that to markup through
 * `renderToStaticMarkup`, so React escapes every value (D-28).
 *
 * A cached page is served to everyone, so no URL is ever derived from the
 * incoming request: the absolute canonical comes from the stored override or
 * from the configured `siteUrl`, and nowhere else.
 */
import { renderToStaticMarkup } from 'react-dom/server';

/** What a document composer needs to write a page's `<head>`. */
export type PageHead = {
  readonly lang: string;
  readonly title: string;
  readonly description: string | null;
  readonly canonicalUrl: string | null;
  readonly robots: string | null;
  readonly imageUrl: string | null;
};

/** What a document composer receives (D-11). */
export type DocumentInput = {
  readonly head: PageHead;
  readonly body: string;
};

/** A host's document composer: the whole HTML document as a string. */
export type RenderDocument = (input: DocumentInput) => string;

/** The stored SEO set, as a structural type so this package needs no
 * `@plakboek/content` dependency. `sitemapInclude` is a sitemap concern,
 * not a head one. */
export type PageSeoInput = {
  readonly title: string | null;
  readonly description: string | null;
  readonly imageAssetId: string | null;
  readonly canonicalUrl: string | null;
  readonly noindex: boolean;
  readonly nofollow: boolean;
};

export type PageHeadInput = {
  readonly lang: string;
  readonly pageTitle: string;
  readonly seo: PageSeoInput;
  /** The page's public path, e.g. `/en/about`. */
  readonly publicPath: string;
  /** The installation's absolute origin, from configuration. */
  readonly siteUrl?: string;
  /** Maps a stored asset id to a public URL; without it no image is emitted. */
  readonly resolveAssetUrl?: (assetId: string) => string | null;
};

function nonBlank(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}

function canonicalFor(input: PageHeadInput): string | null {
  const stored = nonBlank(input.seo.canonicalUrl);
  if (stored !== null) return stored;
  const { siteUrl } = input;
  if (siteUrl === undefined || !/^https?:\/\//i.test(siteUrl)) return null;
  const origin = siteUrl.replace(/\/+$/, '');
  const path = input.publicPath.startsWith('/')
    ? input.publicPath
    : `/${input.publicPath}`;
  return `${origin}${path}`;
}

function robotsFor(seo: PageSeoInput): string | null {
  const directives = [
    ...(seo.noindex ? ['noindex'] : []),
    ...(seo.nofollow ? ['nofollow'] : []),
  ];
  return directives.length === 0 ? null : directives.join(', ');
}

function imageFor(input: PageHeadInput): string | null {
  const { imageAssetId } = input.seo;
  if (imageAssetId === null || input.resolveAssetUrl === undefined) {
    return null;
  }
  const url = input.resolveAssetUrl(imageAssetId);
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/** Builds the head a page emits from its stored SEO set. */
export function buildPageHead(input: PageHeadInput): PageHead {
  return {
    lang: input.lang,
    title: nonBlank(input.seo.title) ?? input.pageTitle,
    description: nonBlank(input.seo.description),
    canonicalUrl: canonicalFor(input),
    robots: robotsFor(input.seo),
    imageUrl: imageFor(input),
  };
}

/** Renders the head elements, omitting any whose value is null. Every value
 * is escaped by React. */
export function renderHeadHtml(head: PageHead): string {
  return renderToStaticMarkup(
    <>
      <title>{head.title}</title>
      {head.description === null ? null : (
        <meta name="description" content={head.description} />
      )}
      {head.canonicalUrl === null ? null : (
        <link rel="canonical" href={head.canonicalUrl} />
      )}
      {head.robots === null ? null : (
        <meta name="robots" content={head.robots} />
      )}
      {head.imageUrl === null ? null : (
        <meta property="og:image" content={head.imageUrl} />
      )}
    </>,
  );
}
