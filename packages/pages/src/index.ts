/**
 * Public barrel for @plakboek/pages, under construction as of plan 04-01.
 *
 * Once complete, named re-exports only, grouped by module, values and types
 * in separate statements -- mirroring @plakboek/content's barrel. A
 * withheld-internals policy will apply here too: the transaction-level tree
 * writers, the unfiltered/row-locking reads, and the Drizzle schema tables
 * stay internal, because a consumer able to reach them could bypass the
 * audited, version-checked, locale-filtered paths this package guarantees.
 *
 * Plan 04-02 replaces this with the tracer's real exports; plan 04-13
 * completes the barrel.
 */

export const PAGES_PACKAGE_NAME = '@plakboek/pages';
