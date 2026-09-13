# @plakboek/permissions

The fixed permission catalogue and code-defined role system for Plakboek
CMS installations.

## What this package is

`@plakboek/permissions` owns a single, frozen catalogue of every permission
string Plakboek understands (`resource:action`, e.g. `pages:publish`). The
catalogue is **exported by this package and cannot be extended, renamed, or
altered per installation** (USER-05) -- it ships with the CMS core, the same
for every install. What an installation _can_ configure in code is which
role holds which of these permissions (`defineRoles`), never the catalogue
itself.

The package has zero runtime dependencies and does no I/O: everything here
is pure, synchronous, in-memory validation and lookup.

## Install

```sh
pnpm add @plakboek/permissions
```

## Permissions

The table below is generated from the catalogue (`PERMISSIONS`) and the
shipped default roles (`defaultRoles`) -- see `docs:permissions` below for
how it stays in sync.

<!-- permissions-table:start -->

| Permission                 | Group         | Description                                                                | superadmin | admin | editor |
| -------------------------- | ------------- | -------------------------------------------------------------------------- | ---------- | ----- | ------ |
| `pages:read`               | pages         | See pages and their published content in the admin                         | ✓          | ✓     | ✓      |
| `pages:read-drafts`        | pages         | See unpublished drafts, previews and revision history of pages             | ✓          | ✓     | ✓      |
| `pages:create`             | pages         | Add new pages to the site                                                  | ✓          | ✓     | ✓      |
| `pages:edit`               | pages         | Change page content, blocks, layout, SEO fields and translations as drafts | ✓          | ✓     | ✓      |
| `pages:publish`            | pages         | Publish or schedule page drafts so visitors receive them                   | ✓          | ✓     | ✓      |
| `pages:delete`             | pages         | Move pages to the trash and restore them                                   | ✓          | ✓     | ✓      |
| `pages:delete-permanent`   | pages         | Permanently remove trashed pages                                           | ✓          |       |        |
| `entries:read`             | entries       | See content entries and their published content in the admin               | ✓          | ✓     | ✓      |
| `entries:read-drafts`      | entries       | See unpublished drafts, previews and revision history of entries           | ✓          | ✓     | ✓      |
| `entries:create`           | entries       | Add new content entries                                                    | ✓          | ✓     | ✓      |
| `entries:edit`             | entries       | Change entry fields and translations as drafts                             | ✓          | ✓     | ✓      |
| `entries:publish`          | entries       | Publish or schedule entry drafts so visitors receive them                  | ✓          | ✓     | ✓      |
| `entries:delete`           | entries       | Move entries to the trash and restore them                                 | ✓          | ✓     | ✓      |
| `entries:delete-permanent` | entries       | Permanently remove trashed entries                                         | ✓          |       |        |
| `templates:edit`           | templates     | Change the shared block tree used to render a content type's detail pages  | ✓          | ✓     | ✓      |
| `templates:publish`        | templates     | Publish changes to shared detail templates                                 | ✓          | ✓     | ✓      |
| `content-types:read`       | content-types | See content types and the fields attached to them                          | ✓          | ✓     | ✓      |
| `content-types:create`     | content-types | Add new content types                                                      | ✓          | ✓     |        |
| `content-types:edit`       | content-types | Change content type settings and add, change or remove fields              | ✓          | ✓     |        |
| `content-types:delete`     | content-types | Remove content types                                                       | ✓          | ✓     |        |
| `media:read`               | media         | Browse and search the media library                                        | ✓          | ✓     | ✓      |
| `media:upload`             | media         | Upload images and files                                                    | ✓          | ✓     | ✓      |
| `media:edit`               | media         | Change alt text, copyright labels and replace assets in place              | ✓          | ✓     | ✓      |
| `media:delete`             | media         | Delete assets, including ones still in use after a warning                 | ✓          | ✓     |        |
| `menus:read`               | menus         | See menus declared by the site and their links                             | ✓          | ✓     | ✓      |
| `menus:edit`               | menus         | Add, remove and re-arrange menu links                                      | ✓          | ✓     | ✓      |
| `redirects:read`           | seo           | See redirects and how long each has been active                            | ✓          | ✓     | ✓      |
| `redirects:manage`         | seo           | Create, change and remove redirects                                        | ✓          | ✓     |        |
| `users:read`               | users         | See users and their roles                                                  | ✓          | ✓     |        |
| `users:create`             | users         | Add users and send or resend set-password emails                           | ✓          | ✓     |        |
| `users:edit`               | users         | Change other users' profile details                                        | ✓          | ✓     |        |
| `users:deactivate`         | users         | Deactivate and reactivate users                                            | ✓          | ✓     |        |
| `users:assign-roles`       | users         | Assign a code-defined role to a user                                       | ✓          | ✓     |        |
| `users:reset-password`     | users         | Set or reset another user's password                                       | ✓          | ✓     |        |
| `users:impersonate`        | users         | Act as another user and return to your own session                         | ✓          |       |        |
| `audit-log:read`           | audit         | See the audit log of data-changing actions                                 | ✓          | ✓     |        |
| `settings:read`            | settings      | See installation settings                                                  | ✓          | ✓     |        |
| `settings:manage`          | settings      | Change core configuration, styles and rules                                | ✓          | ✓     |        |
| `modules:manage`           | settings      | Turn installation modules on or off                                        | ✓          |       |        |
| `blocks:manage`            | settings      | Turn individual built-in sections and blocks on or off                     | ✓          |       |        |
| `bootstrap:run`            | settings      | Run installation bootstrap steps                                           | ✓          |       |        |
| `api-tokens:create`        | api           | Create and revoke your own API tokens for MCP clients                      | ✓          | ✓     | ✓      |
| `api-tokens:manage`        | api           | See and revoke any user's API tokens                                       | ✓          | ✓     |        |
| `backups:manage`           | backups       | Configure backup targets and run backups                                   | ✓          |       |        |
| `backups:restore`          | backups       | Restore the installation from a backup                                     | ✓          |       |        |

<!-- permissions-table:end -->

## Defining roles in code

Roles map a role key to a list of permissions, entirely in your
installation's own code -- there is no database table and no admin UI for
changing what a role _can_ do (only which role a _user_ holds is data,
handled elsewhere). The shipped defaults work unmodified; add or replace
roles by spreading `defaultRoles`:

```ts
import { defineRoles, defaultRoles, ALL_PERMISSIONS } from "@plakboek/permissions";

const roles = defineRoles({
	...defaultRoles,
	// A host-specific role: exactly these two permissions, nothing inherited.
	client: ["pages:read", "pages:edit"],
});
```

`superadmin` is reserved and required: it must be present and must equal
`ALL_PERMISSIONS` exactly (D-11, D-12) --

```ts
defineRoles({
	superadmin: ALL_PERMISSIONS,
	// ...
});
```

-- `defineRoles` throws a single `RoleConfigError` (with a `.issues` array
listing every problem found) if `superadmin` is missing, narrowed, or if any
role references an unknown permission string. There is no inheritance,
`extends`, or wildcard (D-14): a role's permissions are exactly what its
list contains, so any role can be audited by reading one array.

## Orphaned role keys

A user's stored role key (Phase 2) can outlive the role it once named --
the installation's role config changed, or the value was mistyped upstream.
`createPermissionResolver` never throws for this case: an unknown role key
resolves to an **empty permission set**, and the event is reported once,
rate-limited per key, through an injectable hook (D-15):

```ts
import { createPermissionResolver } from "@plakboek/permissions";

const resolver = createPermissionResolver(roles, {
	onOrphanedRole(event) {
		// event: { roleKey, userId?, occurredAt, suppressedCount }
	},
	rateLimitMs: 60_000, // default: one warning per role key per 60s
});

resolver.resolve("some-role-key", { userId: user.id });
```

`OrphanedRoleEvent` carries only `roleKey`, the opaque `userId` (when
known), `occurredAt`, and `suppressedCount` -- never any other user data.
Without a hook, the resolver logs via `console.warn`. A hook that throws is
caught and never propagates into the permission check itself: the empty
set is already decided before the hook runs.

Phase 2's boot-time scan of stored role keys and the Phase 10/11 admin
banner both consume this exact hook rather than re-implementing orphaned
role detection.

## Stability policy

Permission strings are a published contract every host's role config
depends on. Adding a permission is a minor version bump. Renaming or
removing one is a major version bump -- **while the package is pre-1.0, a
rename/removal is a minor bump instead** -- and the old name is kept as a
deprecated alias for one full major version after the rename/removal ships.
A host config that still references the old name keeps booting, with a
warning, for that entire window; it is never rejected outright.

## Security notes

`users:assign-roles` lets its holder assign **any** code-defined role to a
user -- including roles more privileged than their own. This package does
not, and cannot, prevent that: it has no concept of "the currently acting
user" or which permissions they hold at the point of assignment. Wherever
role assignment is implemented (Phase 11), the handler **must** refuse to
assign a role holding any permission the assigning user does not themselves
hold -- otherwise a user with `users:assign-roles` could grant themselves
`superadmin` (USER-02).
