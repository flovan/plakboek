import type { ReactNode } from 'react';
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import appCss from './app.css?url';

// In development the plain `?url` address serves JavaScript, so the dev
// server is asked for the stylesheet itself with its direct-request suffix.
const stylesheetHref = import.meta.env.DEV ? `${appCss}?direct` : appCss;

export const links = () => [{ rel: 'stylesheet', href: stylesheetHref }];

// The root of YOUR routes (see app/routes.ts). CMS pages never render
// through it: their document comes from app/site/document.tsx.
export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="bg-surface font-sans text-text">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}
