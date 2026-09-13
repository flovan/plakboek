import type { Migration } from "../migrate.js";

/**
 * The static migration registry for @plakboek/db (D-03).
 *
 * Adding a migration:
 * 1. Create `src/migrations/NNNN_snake_name.ts` exporting a `Migration`
 *    object named `migration`.
 * 2. Add an explicit static `import` for it below.
 * 3. Append it to the `MIGRATIONS` array, in numeric order.
 *
 * Never edit, rename, or reorder a migration once it has shipped -- shipped
 * migrations are immutable (checksum-enforced) and forward-only.
 * Corrections are always a new, higher-numbered migration. See
 * ../../MIGRATIONS.md for the full authoring convention.
 *
 * MIGRATIONS ships empty at 0.1.0: no product table exists before Phase 2
 * introduces the first schema. The runner, bookkeeping table, advisory
 * lock, and every safety check are fully exercised through fixture
 * registries in this package's own tests (tests/fixtures/migrations.ts).
 */
export const MIGRATIONS: readonly Migration[] = Object.freeze([]);
