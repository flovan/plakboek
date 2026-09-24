import { describe, expect, it } from 'vitest';
import type { Permission } from '../src/catalogue.js';
import { createPermissionResolver } from '../src/resolve.js';
import { defaultRoles, defineRoles } from '../src/roles.js';
import { permissionsIncludeAll } from '../src/superset.js';

describe('permissionsIncludeAll', () => {
  it('returns true when holder has every permission in requirement, plus extra', () => {
    const holder = new Set<Permission>(['pages:read', 'pages:edit']);
    const requirement = new Set<Permission>(['pages:read']);
    expect(permissionsIncludeAll(holder, requirement)).toBe(true);
  });

  it('returns true for equal sets', () => {
    const holder = new Set<Permission>(['pages:read', 'pages:edit']);
    const requirement = new Set<Permission>(['pages:read', 'pages:edit']);
    expect(permissionsIncludeAll(holder, requirement)).toBe(true);
  });

  it('returns false when requirement holds one permission the holder lacks', () => {
    const holder = new Set<Permission>(['pages:read']);
    const requirement = new Set<Permission>(['pages:read', 'pages:edit']);
    expect(permissionsIncludeAll(holder, requirement)).toBe(false);
  });

  it('returns true for any holder against an empty requirement', () => {
    const holder = new Set<Permission>(['pages:read']);
    const requirement = new Set<Permission>();
    expect(permissionsIncludeAll(holder, requirement)).toBe(true);
  });

  it('returns false for an empty holder against a non-empty requirement', () => {
    const holder = new Set<Permission>();
    const requirement = new Set<Permission>(['pages:read']);
    expect(permissionsIncludeAll(holder, requirement)).toBe(false);
  });

  it('returns true for two empty sets', () => {
    expect(
      permissionsIncludeAll(new Set<Permission>(), new Set<Permission>()),
    ).toBe(true);
  });

  it('does not mutate either input set', () => {
    const holder = new Set<Permission>(['pages:read', 'pages:edit']);
    const requirement = new Set<Permission>(['pages:read']);
    const holderSizeBefore = holder.size;
    const requirementSizeBefore = requirement.size;

    permissionsIncludeAll(holder, requirement);

    expect(holder.size).toBe(holderSizeBefore);
    expect(requirement.size).toBe(requirementSizeBefore);
    expect(holder).toEqual(new Set(['pages:read', 'pages:edit']));
    expect(requirement).toEqual(new Set(['pages:read']));
  });

  it('resolved admin permissions include resolved editor permissions, and not the reverse', () => {
    const roles = defineRoles(defaultRoles);
    const resolver = createPermissionResolver(roles);
    const admin = resolver.resolve('admin');
    const editor = resolver.resolve('editor');

    expect(permissionsIncludeAll(admin, editor)).toBe(true);
    expect(permissionsIncludeAll(editor, admin)).toBe(false);
  });
});
