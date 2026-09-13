const mod = await import('@plakboek/permissions');

if (
  !Array.isArray(mod.ALL_PERMISSIONS) ||
  mod.ALL_PERMISSIONS.length === 0 ||
  !Object.isFrozen(mod.ALL_PERMISSIONS)
) {
  process.exit(1);
}

console.log('permissions.mjs: ALL_PERMISSIONS is a non-empty frozen array');

const roles = mod.defineRoles(mod.defaultRoles);
const resolver = mod.createPermissionResolver(roles, {
  onOrphanedRole() {
    // no-op: exercised below for its return-value contract only.
  },
});

if (resolver.resolve('ghost').size !== 0) {
  process.exit(1);
}

console.log(
  'permissions.mjs: defineRoles(defaultRoles) succeeds and an orphaned role key resolves to an empty set',
);
