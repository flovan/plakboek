# create-plakboek

## 0.6.0

### Minor Changes

- [#20](https://github.com/flovan/plakboek/pull/20) [`0bab4f0`](https://github.com/flovan/plakboek/commit/0bab4f098fa9fe7d757df82d9a78edd0f83082d2) Thanks [@flovan](https://github.com/flovan)! - The starter now follows the edit-mode conventions. The root element of `app/site/document.tsx` is a container query root (`@container`), and the starter uses no viewport breakpoint variants. `renderPage` takes the document `mode`, and a new `thirdPartyScripts(mode)` returns nothing in edit mode, so analytics and third-party widgets stay out while an editor works on the page; the error pages render as visitor pages. The README gains an "Edit mode" section (sign-in at `/cms`, the framed site, the `mode` rule, spreading `edit` in blocks, no `X-Frame-Options: DENY` or `frame-ancestors 'none'`, container queries) and describes the reserved `cms` and `api` first segments. The fresh-install proof now checks that the editor is built but never reaches an anonymous visitor.

## 0.5.1

### Patch Changes

- [#17](https://github.com/flovan/plakboek/pull/17) [`7c413c3`](https://github.com/flovan/plakboek/commit/7c413c3a92b6f8bd38117837d3048569f516b41f) Thanks [@flovan](https://github.com/flovan)! - The starter's deploy script now checks the server before it changes anything there. The deploy directory must exist and be writable, and `.env` must be readable and writable by the deploy user. Otherwise the script stops with a message naming the `mkdir`, `chown` or `chmod` command that fixes it. `DEPLOY.md` now says the deploy user owns `.env`, that a commit another workflow pushes with `GITHUB_TOKEN` starts no deploy, that the host scanned for `DEPLOY_KNOWN_HOSTS` must be exactly `DEPLOY_HOST`, and how to find out why Caddy has no certificate.

## 0.5.0

### Minor Changes

- [#15](https://github.com/flovan/plakboek/pull/15) [`6b7be2d`](https://github.com/flovan/plakboek/commit/6b7be2dcc7a74f822efaeea140c8897809faf24a) Thanks [@flovan](https://github.com/flovan)! - First release of `create-plakboek`. `npx create-plakboek [dir]` asks for a project directory, site name, default locale and additional locales (each also a flag, with `--yes` to accept the defaults), writes a Plakboek host project from the template bundled in the package, initialises git and installs with pnpm. Answers reach generated files only as JSON-escaped literals, existing files are never overwritten, and a failed install keeps the project and says how to retry. Requires Node.js 22.22 or later.
