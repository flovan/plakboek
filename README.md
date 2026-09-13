# Plakboek

A modern CMS that allows you to edit content directly on the rendered page.

This repository holds the core packages. Each project scaffolds a host app with `npx`. It can then be extended in code (blocks, templates, roles, styles), deployed and bootstraped.

## Stack

React Router v7 (framework mode, SSR) · React 19 · TypeScript · Tailwind · Postgres + Drizzle · better-auth · TipTap · dnd-kit · MCP server for AI agents

## Packages

| Package                                           | Description                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@plakboek/permissions`](./packages/permissions) | Frozen permission catalogue, code-defined roles (`defineRoles`), and the orphaned-role-safe permission resolver. Zero runtime dependencies. |
| [`@plakboek/db`](./packages/db)                   | Postgres connection factory (Drizzle) and a forward-only, advisory-lock-safe migration runner.                                              |

## Development

Requirements: Node `>=22.16` and pnpm (version pinned via the `packageManager` field in `package.json`).

```sh
docker compose up -d --wait postgres   # local Postgres for integration tests
cp .env.example .env
pnpm install
```

Root scripts (run across every package):

```sh
pnpm run build             # tsdown build for every package
pnpm run test              # unit tests
pnpm run test:integration  # integration tests against real Postgres
pnpm run typecheck         # tsc --noEmit for every package
pnpm run lint              # type-aware oxlint
pnpm run format             # oxfmt (writes)
pnpm run check              # publint + attw per package
pnpm run verify:publishable # pack + install into a throwaway consumer + type-check + runtime import
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contribution workflow, and each package's own README for its public API.

## Status

Early development. `@plakboek/permissions` and `@plakboek/db` are the first two published packages; everything else in the roadmap (host scaffold, admin UI, overlay editing) is not built yet.

## License

MIT -- see [LICENSE](./LICENSE).
