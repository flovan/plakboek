# Your Plakboek site

This project is a site built on the Plakboek CMS. The CMS lives in the `@plakboek/core` and `@plakboek/render` packages; everything you see here is your own code, and you change the site by editing it.

## Getting started

```sh
cp .env.example .env
pnpm --silent secret >> .env
docker compose up -d postgres
pnpm plakboek migrate
pnpm dev
```

Open the address `pnpm dev` prints, followed by `/cms/setup`, to create the first superadmin account. To do it from the terminal instead:

```sh
pnpm plakboek bootstrap --name "Your Name" --email you@example.com
```

Either way the installation gets a published home page from `seed.ts`. The seed only runs on an empty installation, so change it freely.

## What is where

- `plakboek.config.ts` holds the site name, locales, blocks, roles and menus. The `plakboek` command loads it with Node, so it imports plain modules only.
- `blocks/` holds one file per block.
- `app/site/` holds the header, footer, root template and error pages around every CMS page.
- `app/app.css` holds the theme tokens.
- `app/routes.ts` and `app/root.tsx` belong to your own routes.
- `public/` is served as it is, for example `robots.txt`.

## Adding a block

A block is one file in `blocks/` that exports one `defineBlock(...)` definition, plus one entry in the `blocks` list in `plakboek.config.ts`. Copy `blocks/heading.tsx`, change the key, the properties and the component, then add it to the list:

```ts
blocks: [section, heading, myBlock],
```

The component is a plain function component. Do not wrap it in `memo` or `forwardRef`; the visitor renderer refuses wrapped components. Spread the `edit` prop it receives onto the element that should become editable. It adds nothing on a visitor page.

## Editing the header, footer and menus

The header, footer and root template are ordinary files:

- `app/site/header.tsx` shows the site name and the `main` menu.
- `app/site/footer.tsx` shows the same menu and the copyright line.
- `app/site/document.tsx` is the root template: the skip link, header, `main`, footer and the stylesheet link.
- `app/site/errors.tsx` holds the 404 and 500 pages. They use the root template and show no error details.

Menus are declared in `plakboek.config.ts` under `menus`. The header and the footer read the `main` menu through `site.getMenu('main')`, so they keep working when menus move out of code. A malformed menu item stops the site from starting, so it never reaches a page.

Visitor pages carry no script of your own. Keep it that way: the only script on a page is the editor bootstrap the CMS adds.

## Live reload in development

Edit a block or any file in `app/site/` while `pnpm dev` runs and the browser reloads on its own. The whole page reloads: visitor pages ship no client React, so nothing is hot swapped and scroll position is not kept. A block that throws is left out of the page and reported in the terminal.

## Reserved paths

The CMS owns two path prefixes:

- `/cms` for its own pages, such as `/cms/setup` and `/cms/health`.
- `/api/auth` for sign-in and account requests.

A page with the slug `cms` or `api` cannot be reached, because these routes win over any page. Do not add routes of your own under these prefixes. Every other path that your routes do not claim is looked up as a CMS page.

## Linking to CMS pages from your own routes

CMS pages have no client route module. From a route of your own, link to them with a plain anchor or with `reloadDocument`:

```tsx
<a href="/about">About</a>
<Link to="/about" reloadDocument>About</Link>
```

A plain `<Link to="/about">` tries a client navigation and does not find the page.

## First-run setup on a public URL

Until the first account exists, anyone who reaches `/cms/setup` can create it, and that account becomes the superadmin. On a freshly deployed public address the first person to open the page wins. The page has no setup token by design and closes once an account exists. With the shipped deployment, create the account from the server right after the first deploy with the command in `DEPLOY.md`, under "The first deploy", which also says how to check that the account is yours. Once an account exists, `/cms/setup` answers with the same 404 as any unknown page.

## Email

Set the `PLAKBOEK_SMTP_*` variables in `.env` to send email. With no SMTP host in development, mail is printed to the terminal instead. Check delivery with:

```sh
pnpm plakboek mail:test you@example.com
```

## Migrations

`pnpm plakboek migrate` applies the CMS migrations. Your project has no migrations of its own. Run it against a direct database connection, not a connection pooler, because it holds a session lock while it works. If `DATABASE_URL` points at a pooler, set `DATABASE_MIGRATION_URL` to the direct address and the command uses that one.

## Content Security Policy

The editor bootstrap is a small inline script. If you send a `Content-Security-Policy` header, allow it with a hash rather than `unsafe-inline`. The hash is exported as `TOOLBAR_BOOTSTRAP_CSP_HASH` from `@plakboek/render/server`:

```ts
import { TOOLBAR_BOOTSTRAP_CSP_HASH } from '@plakboek/render/server';

const scriptSrc = `script-src 'self' '${TOOLBAR_BOOTSTRAP_CSP_HASH}'`;
```

## Deployment

See `DEPLOY.md` for building the image, running the migration step and putting the site behind a reverse proxy.
