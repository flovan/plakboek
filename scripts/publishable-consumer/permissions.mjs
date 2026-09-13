const mod = await import("@plakboek/permissions");

if (
  !Array.isArray(mod.ALL_PERMISSIONS) ||
  mod.ALL_PERMISSIONS.length === 0 ||
  !Object.isFrozen(mod.ALL_PERMISSIONS)
) {
  process.exit(1);
}

console.log("permissions.mjs: ALL_PERMISSIONS is a non-empty frozen array");
