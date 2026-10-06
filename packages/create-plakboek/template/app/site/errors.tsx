import type { SiteContext } from '@plakboek/core';
import type { PageHead } from '@plakboek/render';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderPage } from './document.tsx';

const textLink =
  'text-accent underline hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

type MessageProps = {
  readonly title: string;
  readonly body: string;
  readonly hint?: boolean;
};

// The content of an error page: one contained section with a heading, a
// sentence and a link home. Nothing from the request or the failure is shown.
function Message({ title, body, hint = false }: MessageProps) {
  return (
    <section className="mx-auto w-full max-w-[1120px] px-6 py-16">
      <h1 className="text-3xl font-semibold wrap-anywhere">{title}</h1>
      <p className="mt-2 text-base">{body}</p>
      {hint ? (
        <p className="mt-4 text-sm text-text-muted">
          No home page yet. Run <code>pnpm plakboek bootstrap</code>, or open
          /cms/setup, to create the first account and the seed page.
        </p>
      ) : null}
      <p className="mt-4 text-base">
        <a href="/" className={textLink}>
          Go to the home page
        </a>
      </p>
    </section>
  );
}

function errorHead(title: string, site: SiteContext): PageHead {
  return {
    lang: site.locale,
    title,
    description: null,
    canonicalUrl: null,
    robots: 'noindex',
    imageUrl: null,
  };
}

// The handler sets the 404 status and the cache headers; this is the body.
export async function renderNotFound(
  request: Request,
  site: SiteContext,
): Promise<string> {
  // The hint only helps while you are building the site: never in production,
  // and only where a missing home page is the likely reason.
  const hint =
    process.env.NODE_ENV !== 'production' &&
    new URL(request.url).pathname === '/';
  return await renderPage({
    head: errorHead('Page not found', site),
    main: renderToStaticMarkup(
      <Message
        title="Page not found"
        body="The page you asked for does not exist or is not published."
        hint={hint}
      />,
    ),
    site,
  });
}

// The handler sets the 500 status and the cache headers. The copy is fixed:
// no error text, stack or identifier ever reaches the visitor.
export async function renderError(
  _request: Request,
  site: SiteContext,
): Promise<string> {
  return await renderPage({
    head: errorHead('Something went wrong', site),
    main: renderToStaticMarkup(
      <Message
        title="Something went wrong"
        body="The page could not be shown. Try again in a moment."
      />,
    ),
    site,
  });
}
