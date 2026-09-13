/**
 * Generates the README.md permissions table from the single source of
 * truth (`PERMISSIONS`/`ALL_PERMISSIONS` for catalogue content,
 * `defaultRoles` for which shipped role holds which permission). Used by
 * both `tests/readme.test.ts` (drift check / regeneration) and the
 * `docs:permissions` package script.
 */
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  type Permission,
} from '../../src/catalogue.js';
import { defaultRoles } from '../../src/roles.js';

const ROLE_COLUMNS = ['superadmin', 'admin', 'editor'] as const;

// `defaultRoles[role]` is a per-role narrow literal tuple type (from
// `as const satisfies RoleConfig`), not `readonly Permission[]` --
// widening via an explicit `Set<Permission>` type argument avoids an `as`
// cast while giving every role the same `.has(permission)` shape below.
const ROLE_PERMISSION_SETS: Record<
  (typeof ROLE_COLUMNS)[number],
  ReadonlySet<Permission>
> = {
  superadmin: new Set<Permission>(defaultRoles.superadmin),
  admin: new Set<Permission>(defaultRoles.admin),
  editor: new Set<Permission>(defaultRoles.editor),
};

/** Render the full permissions table as GitHub-flavored Markdown, one row
 * per `ALL_PERMISSIONS` entry in catalogue declaration order. */
export function renderPermissionsTable(): string {
  const header = `| Permission | Group | Description | ${ROLE_COLUMNS.join(' | ')} |`;
  const separator = `| --- | --- | --- | ${ROLE_COLUMNS.map(() => '---').join(' | ')} |`;

  const rows = ALL_PERMISSIONS.map((permission) => {
    const meta = PERMISSIONS[permission];
    const cells = ROLE_COLUMNS.map((role) =>
      ROLE_PERMISSION_SETS[role].has(permission) ? '✓' : '',
    );
    return `| \`${permission}\` | ${meta.group} | ${meta.description.message} | ${cells.join(' | ')} |`;
  });

  return [header, separator, ...rows].join('\n');
}
