import type { Migration } from '../migrate.js';
import { migration as m0001 } from './0001_auth_core.js';
import { migration as m0002 } from './0002_content_engine.js';

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
 * `0001_auth_core` is the first shipped entry: the better-auth core tables
 * and the audit log. `0002_content_engine` is the second: the content-type,
 * field and entry tables `@plakboek/content` builds on. The runner's
 * failure modes (ordering, checksums, partial application, locking) are
 * exercised through fixture registries in this package's own tests
 * (tests/fixtures/migrations.ts).
 */
export const MIGRATIONS: readonly Migration[] = Object.freeze([m0001, m0002]);
