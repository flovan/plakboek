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
- `text-theme.tsx` holds the text theme: what an editor may do in a text field and how that text looks.
- `app/routes.ts` and `app/root.tsx` belong to your own routes.
- `public/` is served as it is, for example `robots.txt`.

## Adding a block

A block is one file in `blocks/` that exports one `defineBlock(...)` definition, plus one entry in the `blocks` list in `plakboek.config.ts`. Copy `blocks/heading.tsx`, change the key, the properties and the component, then add it to the list:

```ts
blocks: [section, heading, text, button, myBlock],
```

The component is a plain function component. Do not wrap it in `memo` or `forwardRef`; the visitor renderer refuses wrapped components. Spread `{...edit}` on the component's root element, because that is what the page editor outlines, selects and drills into, and a block without it cannot be reached on the page. Spread `{...edit.field('text')}` on the element that shows a property, as `blocks/heading.tsx` does. Neither adds anything to a visitor page.

## Text and buttons

Editors write formatted text on the page itself, in the `body` of the Text block. One text theme governs every text field of the site. It lives in `text-theme.tsx`, which `plakboek.config.ts` passes to `defineConfig({ textTheme })` and which the Vite plugin finds by its default name, `/text-theme.{ts,tsx}`, so the server and the page editor read the same file. Keep its imports to `react` and `@plakboek/render`, because the file also loads in the editor.

- The palettes name tokens of `app/app.css`: colours `text`, `text-muted` and `accent`, sizes `sm`, `xl` and `display` (the `--text-3xl` variable; a token starts with a letter, so the 28px size cannot be named `3xl`). The editor shows the labels, never the token names. To offer a new colour, add its token to `app/app.css` and an entry to the palette.
- The token block in `app/app.css` stays `@theme static`. Text stores a colour or size as a token name and renders `var(--color-accent)` style references. With a plain `@theme` block, Tailwind leaves out every variable no rule uses, and a stored token would silently resolve to nothing on a page that has no matching utility.
- Each node and mark has a renderer, and `text-theme.tsx` overrides the ones that carry the starter's look as Tailwind classes. Override one entry in `renderers` and every other entry keeps its default. A renderer shows its `children` inside exactly one element. The page, the editor and the Button block all render through the same map.
- A text property can narrow the theme, never widen it: `options: { narrow: { marks: ['bold', 'italic', 'link'] } }` keeps only those marks on that field. A `narrow` that names something the theme lacks stops the site from starting.
- Any block can make a `rich_text` or `short_text` property editable on the page with `{...edit.field('name')}` on the element that shows it. `blocks/text.tsx` does this and renders the value with `<RichText value={props.body} />`, with no wrapper of its own.
- `blocks/button.tsx` is a standalone button: a label, a link and a style taken from the theme's call-to-action variants. It renders through the same `cta` renderer as a button typed into text, so the two look identical.
- The Heading block offers Title, Heading and Subheading (`h2` to `h4`) with the same classes as headings in text, and no `h1`. The single `h1` of a page is the site name in `app/site/header.tsx`. If you want the page title there instead, change the header.

## Editing the header, footer and menus

The header, footer and root template are ordinary files:

- `app/site/header.tsx` shows the site name, as the page's `h1`, and the `main` menu.
- `app/site/footer.tsx` shows the same menu and the copyright line.
- `app/site/document.tsx` is the root template: the skip link, header, `main`, footer and the stylesheet link.
- `app/site/errors.tsx` holds the 404 and 500 pages. They use the root template and show no error details.

Menus are declared in `plakboek.config.ts` under `menus`. The header and the footer read the `main` menu through `site.getMenu('main')`, so they keep working when menus move out of code. A malformed menu item stops the site from starting, so it never reaches a page.

Visitor pages carry no script of your own. Keep it that way: the only script on a page is the editor bootstrap the CMS adds.

## Edit mode

Editors sign in at `/cms`. There is no login link on the site, by design: a visitor page carries no editor script and no way in. Once an editor has signed in on a browser, the site shows them a small Edit button.

In edit mode the CMS shows your own document and blocks for the same URL inside a frame, next to the editor sidebar. The framed page is your site at its own address, rendered by your `renderDocument` and your blocks, not a separate preview. What you need to do as the developer:

- `renderDocument` receives `mode`, which is `'visitor'` or `'edit'`. Leave analytics and third-party widgets out when it is `'edit'`, so editing never counts as a visit. `app/site/document.tsx` does this through one function, `thirdPartyScripts(mode)`; add your tags there. Scripts that a block owns keep running in edit mode, so the block still behaves as it does for a visitor.
- Spread `{...edit}` on every block's root element and `{...edit.field('name')}` on the element that shows a property, so the editor can outline, select and drill into the block. Neither adds anything on a visitor page.
- Do not send `X-Frame-Options: DENY` or `Content-Security-Policy: frame-ancestors 'none'` on site pages. The CMS frames them from the same origin, so a header that allows the same origin (`SAMEORIGIN` or `'self'`) is fine.
- Write responsive rules with container queries. The root element in `app/site/document.tsx` is a container (`@container`), so the `@sm:` to `@3xl:` variants follow the space the page actually has, in the frame and on the open web alike. Viewport media queries and the `sm:` to `2xl:` variants also work: in edit mode they follow the width of the frame, because the frame is a viewport of its own. The starter uses no viewport variants, and your theme is easier to reason about if it follows suit.

## Live reload in development

Edit a block or any file in `app/site/` while `pnpm dev` runs and the browser reloads on its own. The whole page reloads: visitor pages ship no client React, so nothing is hot swapped and scroll position is not kept. In edit mode a block change reloads the edit page. A block that throws is left out of the page and reported in the terminal.

## Reserved paths

The CMS owns two path prefixes:

- `/cms` for its own pages, such as `/cms/setup` and `/cms/health`.
- `/api/auth` for sign-in and account requests.

A page with the slug `cms` or `api` cannot be reached, because these routes win over any page. Creating or renaming a page so that its first segment is `cms` or `api` is refused. A page that already has one of them is reported at start-up and kept, so rename it yourself. Do not add routes of your own under these prefixes. Every other path that your routes do not claim is looked up as a CMS page.

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

Text can also need inline styles. A custom colour, a custom size and a paragraph or heading alignment an editor chose render as `style` attributes, which a strict `style-src` refuses. Colours and sizes picked from the palette render as CSS variable references, which are inline styles too. A host with a strict `style-src` sets `allowCustomValues: false` in `text-theme.tsx` and overrides the `textColor`, `textSize`, `paragraph` and `heading` renderers to emit classes instead, for example one class per palette token and per alignment.

## Deployment

See `DEPLOY.md` for building the image, running the migration step and putting the site behind a reverse proxy.
