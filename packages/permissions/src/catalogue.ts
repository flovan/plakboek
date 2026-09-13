/**
 * The frozen permission catalogue. This is the single source of truth for
 * every permission string in the system (USER-05): it is owned by this
 * package, exported read-only, and cannot be altered per installation.
 *
 * Label/description values are Lingui MessageDescriptor-compatible plain
 * objects (`{ id, message }`). This package has zero runtime dependencies
 * (D-16): it never imports `@lingui/core` itself, it only ships the message
 * ids and English source text for a later phase's admin shell to resolve.
 *
 * Permission strings are `resource:action` with no own/any ownership split
 * (D-05); publishing is always its own permission, separate from editing
 * (D-06). This is the full v1 catalogue (D-07) — 45 permissions across 12
 * groups. Per D-11 no wildcard or superadmin flag is added here; superadmin
 * is a plain role holding `ALL_PERMISSIONS` (plan 01-04). Which of these
 * permissions land on the shipped `admin` vs `superadmin` default role is
 * also plan 01-04's concern — this file only defines what each permission
 * string means, not who holds it by default.
 */

/** A Lingui MessageDescriptor-compatible plain object: `id` is the Lingui
 * message key, `message` is the English source text. */
export interface PermissionMessage {
	readonly id: string;
	readonly message: string;
}

/** Metadata carried by every catalogue entry. */
export interface PermissionMeta {
	readonly group: PermissionGroup;
	readonly label: PermissionMessage;
	readonly description: PermissionMessage;
}

/** The 12 v1 permission groups, in catalogue table order. */
export type PermissionGroup =
	| "pages"
	| "entries"
	| "templates"
	| "content-types"
	| "media"
	| "menus"
	| "seo"
	| "users"
	| "audit"
	| "settings"
	| "api"
	| "backups";

/**
 * The frozen v1 permission catalogue (D-07). Every catalogue entry uses
 * `resource:action` strings with no ownership split (D-05); publishing is
 * its own permission, separate from editing (D-06).
 */
export const PERMISSIONS = {
	// pages -- EDIT-06, ADMIN-01, PUB-01/02/03/04/06/07/08/09/10, BLOCK-01..09,
	// SEO-01/04/05, I18N-05
	"pages:read": {
		group: "pages",
		label: { id: "permissions.pages.read.label", message: "View pages" },
		description: {
			id: "permissions.pages.read.description",
			message: "See pages and their published content in the admin",
		},
	},
	"pages:read-drafts": {
		group: "pages",
		label: {
			id: "permissions.pages.readDrafts.label",
			message: "View page drafts",
		},
		description: {
			id: "permissions.pages.readDrafts.description",
			message: "See unpublished drafts, previews and revision history of pages",
		},
	},
	"pages:create": {
		group: "pages",
		label: { id: "permissions.pages.create.label", message: "Create pages" },
		description: {
			id: "permissions.pages.create.description",
			message: "Add new pages to the site",
		},
	},
	"pages:edit": {
		group: "pages",
		label: { id: "permissions.pages.edit.label", message: "Edit pages" },
		description: {
			id: "permissions.pages.edit.description",
			message: "Change page content, blocks, layout, SEO fields and translations as drafts",
		},
	},
	"pages:publish": {
		group: "pages",
		label: { id: "permissions.pages.publish.label", message: "Publish pages" },
		description: {
			id: "permissions.pages.publish.description",
			message: "Publish or schedule page drafts so visitors receive them",
		},
	},
	"pages:delete": {
		group: "pages",
		label: { id: "permissions.pages.delete.label", message: "Delete pages" },
		description: {
			id: "permissions.pages.delete.description",
			message: "Move pages to the trash and restore them",
		},
	},
	// Distinct from pages:delete (trash/soft-delete) so a role can move pages
	// to trash without being able to purge them irrecoverably.
	"pages:delete-permanent": {
		group: "pages",
		label: {
			id: "permissions.pages.deletePermanent.label",
			message: "Permanently delete pages",
		},
		description: {
			id: "permissions.pages.deletePermanent.description",
			message: "Permanently remove trashed pages",
		},
	},

	// entries -- TYPE-10, ADMIN-04, PUB-01/02/03/04/06/07/08/09/10, FIELD-05,
	// AI-06, AI-08, SEO-02, I18N-05
	"entries:read": {
		group: "entries",
		label: { id: "permissions.entries.read.label", message: "View entries" },
		description: {
			id: "permissions.entries.read.description",
			message: "See content entries and their published content in the admin",
		},
	},
	"entries:read-drafts": {
		group: "entries",
		label: {
			id: "permissions.entries.readDrafts.label",
			message: "View entry drafts",
		},
		description: {
			id: "permissions.entries.readDrafts.description",
			message: "See unpublished drafts, previews and revision history of entries",
		},
	},
	"entries:create": {
		group: "entries",
		label: { id: "permissions.entries.create.label", message: "Create entries" },
		description: {
			id: "permissions.entries.create.description",
			message: "Add new content entries",
		},
	},
	"entries:edit": {
		group: "entries",
		label: { id: "permissions.entries.edit.label", message: "Edit entries" },
		description: {
			id: "permissions.entries.edit.description",
			message: "Change entry fields and translations as drafts",
		},
	},
	"entries:publish": {
		group: "entries",
		label: { id: "permissions.entries.publish.label", message: "Publish entries" },
		description: {
			id: "permissions.entries.publish.description",
			message: "Publish or schedule entry drafts so visitors receive them",
		},
	},
	"entries:delete": {
		group: "entries",
		label: { id: "permissions.entries.delete.label", message: "Delete entries" },
		description: {
			id: "permissions.entries.delete.description",
			message: "Move entries to the trash and restore them",
		},
	},
	// Distinct from entries:delete for the same reason as pages:delete-permanent.
	"entries:delete-permanent": {
		group: "entries",
		label: {
			id: "permissions.entries.deletePermanent.label",
			message: "Permanently delete entries",
		},
		description: {
			id: "permissions.entries.deletePermanent.description",
			message: "Permanently remove trashed entries",
		},
	},

	// templates -- REPEAT-09, PUB-03
	"templates:edit": {
		group: "templates",
		label: {
			id: "permissions.templates.edit.label",
			message: "Edit detail templates",
		},
		description: {
			id: "permissions.templates.edit.description",
			message: "Change the shared block tree used to render a content type's detail pages",
		},
	},
	"templates:publish": {
		group: "templates",
		label: {
			id: "permissions.templates.publish.label",
			message: "Publish detail templates",
		},
		description: {
			id: "permissions.templates.publish.description",
			message: "Publish changes to shared detail templates",
		},
	},

	// content-types -- TYPE-01..12, FIELD-01..04, FIELD-06, AI-05
	"content-types:read": {
		group: "content-types",
		label: {
			id: "permissions.contentTypes.read.label",
			message: "View content types",
		},
		description: {
			id: "permissions.contentTypes.read.description",
			message: "See content types and the fields attached to them",
		},
	},
	"content-types:create": {
		group: "content-types",
		label: {
			id: "permissions.contentTypes.create.label",
			message: "Create content types",
		},
		description: {
			id: "permissions.contentTypes.create.description",
			message: "Add new content types",
		},
	},
	"content-types:edit": {
		group: "content-types",
		label: {
			id: "permissions.contentTypes.edit.label",
			message: "Edit content types",
		},
		description: {
			id: "permissions.contentTypes.edit.description",
			message: "Change content type settings and add, change or remove fields",
		},
	},
	"content-types:delete": {
		group: "content-types",
		label: {
			id: "permissions.contentTypes.delete.label",
			message: "Delete content types",
		},
		description: {
			id: "permissions.contentTypes.delete.description",
			message: "Remove content types",
		},
	},

	// media -- MEDIA-01..04, MEDIA-07, MEDIA-08
	"media:read": {
		group: "media",
		label: { id: "permissions.media.read.label", message: "View media" },
		description: {
			id: "permissions.media.read.description",
			message: "Browse and search the media library",
		},
	},
	"media:upload": {
		group: "media",
		label: { id: "permissions.media.upload.label", message: "Upload media" },
		description: {
			id: "permissions.media.upload.description",
			message: "Upload images and files",
		},
	},
	"media:edit": {
		group: "media",
		label: { id: "permissions.media.edit.label", message: "Edit media" },
		description: {
			id: "permissions.media.edit.description",
			message: "Change alt text, copyright labels and replace assets in place",
		},
	},
	"media:delete": {
		group: "media",
		label: { id: "permissions.media.delete.label", message: "Delete media" },
		description: {
			id: "permissions.media.delete.description",
			message: "Delete assets, including ones still in use after a warning",
		},
	},

	// menus -- MENU-01..04
	"menus:read": {
		group: "menus",
		label: { id: "permissions.menus.read.label", message: "View menus" },
		description: {
			id: "permissions.menus.read.description",
			message: "See menus declared by the site and their links",
		},
	},
	"menus:edit": {
		group: "menus",
		label: { id: "permissions.menus.edit.label", message: "Edit menus" },
		description: {
			id: "permissions.menus.edit.description",
			message: "Add, remove and re-arrange menu links",
		},
	},

	// seo (redirects) -- SEO-07..10
	"redirects:read": {
		group: "seo",
		label: { id: "permissions.redirects.read.label", message: "View redirects" },
		description: {
			id: "permissions.redirects.read.description",
			message: "See redirects and how long each has been active",
		},
	},
	"redirects:manage": {
		group: "seo",
		label: {
			id: "permissions.redirects.manage.label",
			message: "Manage redirects",
		},
		description: {
			id: "permissions.redirects.manage.description",
			message: "Create, change and remove redirects",
		},
	},

	// users -- USER-01, USER-02, USER-06, USER-07, USER-10, AUTH-02, AUTH-04
	"users:read": {
		group: "users",
		label: { id: "permissions.users.read.label", message: "View users" },
		description: {
			id: "permissions.users.read.description",
			message: "See users and their roles",
		},
	},
	"users:create": {
		group: "users",
		label: { id: "permissions.users.create.label", message: "Invite users" },
		description: {
			id: "permissions.users.create.description",
			message: "Add users and send or resend set-password emails",
		},
	},
	"users:edit": {
		group: "users",
		label: { id: "permissions.users.edit.label", message: "Edit users" },
		description: {
			id: "permissions.users.edit.description",
			message: "Change other users' profile details",
		},
	},
	"users:deactivate": {
		group: "users",
		label: {
			id: "permissions.users.deactivate.label",
			message: "Deactivate users",
		},
		description: {
			id: "permissions.users.deactivate.description",
			message: "Deactivate and reactivate users",
		},
	},
	"users:assign-roles": {
		group: "users",
		label: { id: "permissions.users.assignRoles.label", message: "Assign roles" },
		description: {
			id: "permissions.users.assignRoles.description",
			message: "Assign a code-defined role to a user",
		},
	},
	"users:reset-password": {
		group: "users",
		label: {
			id: "permissions.users.resetPassword.label",
			message: "Reset passwords",
		},
		description: {
			id: "permissions.users.resetPassword.description",
			message: "Set or reset another user's password",
		},
	},
	// Kept as its own permission (rather than folded into users:edit) because
	// acting as another user is meaningfully more privileged than editing
	// their profile -- a role can manage users without being able to become
	// them. Whether the default `admin` role holds it is plan 01-04's split.
	"users:impersonate": {
		group: "users",
		label: {
			id: "permissions.users.impersonate.label",
			message: "Impersonate users",
		},
		description: {
			id: "permissions.users.impersonate.description",
			message: "Act as another user and return to your own session",
		},
	},

	// audit -- USER-08, USER-09
	"audit-log:read": {
		group: "audit",
		label: { id: "permissions.auditLog.read.label", message: "View audit log" },
		description: {
			id: "permissions.auditLog.read.description",
			message: "See the audit log of data-changing actions",
		},
	},

	// settings -- ADMIN-02, INST-07, BLOCK-10, AI-04
	"settings:read": {
		group: "settings",
		label: { id: "permissions.settings.read.label", message: "View settings" },
		description: {
			id: "permissions.settings.read.description",
			message: "See installation settings",
		},
	},
	"settings:manage": {
		group: "settings",
		label: {
			id: "permissions.settings.manage.label",
			message: "Manage settings",
		},
		description: {
			id: "permissions.settings.manage.description",
			message: "Change core configuration, styles and rules",
		},
	},
	// Toggling entire installation modules on/off is an infra-level decision,
	// kept distinct from day-to-day settings:manage so it can be withheld
	// separately (default-role split is plan 01-04).
	"modules:manage": {
		group: "settings",
		label: { id: "permissions.modules.manage.label", message: "Manage modules" },
		description: {
			id: "permissions.modules.manage.description",
			message: "Turn installation modules on or off",
		},
	},
	// Toggling which built-in sections/blocks are available is a site-shape
	// decision, distinct from editing content that already uses them
	// (default-role split is plan 01-04).
	"blocks:manage": {
		group: "settings",
		label: {
			id: "permissions.blocks.manage.label",
			message: "Manage built-in blocks",
		},
		description: {
			id: "permissions.blocks.manage.description",
			message: "Turn individual built-in sections and blocks on or off",
		},
	},
	// One-time/destructive installation setup steps; kept separate so it is
	// never implied by general settings access (default-role split is plan
	// 01-04).
	"bootstrap:run": {
		group: "settings",
		label: { id: "permissions.bootstrap.run.label", message: "Run bootstrap" },
		description: {
			id: "permissions.bootstrap.run.description",
			message: "Run installation bootstrap steps",
		},
	},

	// api -- AI-02
	"api-tokens:create": {
		group: "api",
		label: {
			id: "permissions.apiTokens.create.label",
			message: "Create API tokens",
		},
		description: {
			id: "permissions.apiTokens.create.description",
			message: "Create and revoke your own API tokens for MCP clients",
		},
	},
	"api-tokens:manage": {
		group: "api",
		label: {
			id: "permissions.apiTokens.manage.label",
			message: "Manage API tokens",
		},
		description: {
			id: "permissions.apiTokens.manage.description",
			message: "See and revoke any user's API tokens",
		},
	},

	// backups -- INFRA-06, INFRA-07
	"backups:manage": {
		group: "backups",
		label: { id: "permissions.backups.manage.label", message: "Manage backups" },
		description: {
			id: "permissions.backups.manage.description",
			message: "Configure backup targets and run backups",
		},
	},
	// Restoring is a destructive, all-or-nothing rollback of live data --
	// split from backups:manage so a role can configure/run backups without
	// being able to roll the whole install back (default-role split is plan
	// 01-04).
	"backups:restore": {
		group: "backups",
		label: {
			id: "permissions.backups.restore.label",
			message: "Restore backups",
		},
		description: {
			id: "permissions.backups.restore.description",
			message: "Restore the installation from a backup",
		},
	},
} as const satisfies Record<string, PermissionMeta>;

// Deep-freeze the catalogue at module load so PERMISSIONS, its metadata
// objects, and their label/description objects are all immutable at
// runtime, not just at the type level (USER-05, T-01-06).
for (const meta of Object.values(PERMISSIONS)) {
	Object.freeze(meta.label);
	Object.freeze(meta.description);
	Object.freeze(meta);
}
Object.freeze(PERMISSIONS);

/** The union of every valid permission string, derived from the catalogue. */
export type Permission = keyof typeof PERMISSIONS;

/** Runtime type guard for an arbitrary value being a known permission string.
 * Uses `Object.hasOwn` (not `in` or bracket access) so inherited
 * `Object.prototype` keys (`constructor`, `toString`, `__proto__`, ...) are
 * never classified as permissions (T-01-08). */
export function isPermission(value: unknown): value is Permission {
	return typeof value === "string" && Object.hasOwn(PERMISSIONS, value);
}

/** Every permission string, in catalogue declaration order, frozen. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze(
	Object.keys(PERMISSIONS).filter(isPermission),
);

/** The 12 v1 permission groups, in catalogue table order, frozen. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = Object.freeze([
	"pages",
	"entries",
	"templates",
	"content-types",
	"media",
	"menus",
	"seo",
	"users",
	"audit",
	"settings",
	"api",
	"backups",
]);
