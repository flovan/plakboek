/**
 * The permission-superset rule (D-44): whether one resolved permission set
 * "outranks" another for the purpose of an action one actor takes on
 * another -- edit-lock takeover in `@plakboek/content` (plan 03-06), and
 * Phase 11's "act only on users/roles whose permissions you already hold"
 * rule. "Higher" here means permission superset, not any notion of role
 * rank or hierarchy: equal sets qualify. Callers resolve both sides through
 * `PermissionResolver.resolve` at decision time -- this function only
 * compares the two sets it is given.
 */
import type { Permission } from './catalogue.js';

/**
 * Returns `true` when every permission in `requirement` is also present in
 * `holder` -- `holder` is a permission superset of (or equal to)
 * `requirement`. An empty `requirement` is satisfied by any `holder`,
 * including an empty one. Neither input set is mutated.
 */
export function permissionsIncludeAll(
  holder: ReadonlySet<Permission>,
  requirement: ReadonlySet<Permission>,
): boolean {
  for (const permission of requirement) {
    if (!holder.has(permission)) {
      return false;
    }
  }
  return true;
}
