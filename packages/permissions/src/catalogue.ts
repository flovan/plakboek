/**
 * The frozen permission catalogue. This is the single source of truth for
 * every permission string in the system (USER-05): it is owned by this
 * package, exported read-only, and cannot be altered per installation.
 *
 * Label/description values are Lingui MessageDescriptor-compatible plain
 * objects (`{ id, message }`). This package has zero runtime dependencies
 * (D-16): it never imports `@lingui/core` itself, it only ships the message
 * ids and English source text for a later phase's admin shell to resolve.
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

/** Permission groups. Only "pages" ships in this slice; further groups are
 * added by plan 01-02. */
export type PermissionGroup = "pages";

/**
 * The frozen permission catalogue (pages group). Every catalogue entry uses
 * `resource:action` strings with no ownership split (D-05); publishing is
 * its own permission, separate from editing (D-06).
 */
export const PERMISSIONS = {
	"pages:read": {
		group: "pages",
		label: { id: "permissions.pages.read.label", message: "View pages" },
		description: {
			id: "permissions.pages.read.description",
			message: "View pages and their content",
		},
	},
	"pages:read-drafts": {
		group: "pages",
		label: {
			id: "permissions.pages.readDrafts.label",
			message: "View draft pages",
		},
		description: {
			id: "permissions.pages.readDrafts.description",
			message: "View unpublished draft versions of pages",
		},
	},
	"pages:create": {
		group: "pages",
		label: { id: "permissions.pages.create.label", message: "Create pages" },
		description: {
			id: "permissions.pages.create.description",
			message: "Create new pages",
		},
	},
	"pages:edit": {
		group: "pages",
		label: { id: "permissions.pages.edit.label", message: "Edit pages" },
		description: {
			id: "permissions.pages.edit.description",
			message: "Edit page content, layout, and block arrangement",
		},
	},
	"pages:publish": {
		group: "pages",
		label: { id: "permissions.pages.publish.label", message: "Publish pages" },
		description: {
			id: "permissions.pages.publish.description",
			message: "Publish draft changes to pages, making them live",
		},
	},
	"pages:delete": {
		group: "pages",
		label: { id: "permissions.pages.delete.label", message: "Delete pages" },
		description: {
			id: "permissions.pages.delete.description",
			message: "Move pages to trash",
		},
	},
	"pages:delete-permanent": {
		group: "pages",
		label: {
			id: "permissions.pages.deletePermanent.label",
			message: "Permanently delete pages",
		},
		description: {
			id: "permissions.pages.deletePermanent.description",
			message: "Permanently delete pages, bypassing trash",
		},
	},
} as const satisfies Record<string, PermissionMeta>;

// Deep-freeze the catalogue at module load so PERMISSIONS, its metadata
// objects, and their label/description objects are all immutable at
// runtime, not just at the type level (USER-05, T-01-03).
for (const meta of Object.values(PERMISSIONS)) {
	Object.freeze(meta.label);
	Object.freeze(meta.description);
	Object.freeze(meta);
}
Object.freeze(PERMISSIONS);

/** The union of every valid permission string, derived from the catalogue. */
export type Permission = keyof typeof PERMISSIONS;

/** Runtime type guard for an arbitrary value being a known permission string. */
export function isPermission(value: unknown): value is Permission {
	return typeof value === "string" && Object.hasOwn(PERMISSIONS, value);
}

/** Every permission string, in catalogue declaration order, frozen. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze(
	Object.keys(PERMISSIONS).filter(isPermission),
);
