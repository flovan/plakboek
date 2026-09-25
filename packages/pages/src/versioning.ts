/**
 * In-memory upcast-on-read (D-10, D-11, D-12, D-15, BLOCK-12). Never
 * mutates the stored row: the same `props` bytes are in Postgres before
 * and after a read -- the upgraded shape is written back only when the
 * block is next saved (D-11). Plan 04-07 adds memoisation of the resolved
 * upcaster chain, the below-floor warning report and `compactBlockType`.
 */
import type { BlockDefinition } from './registry.js';

export type UpcastResult =
  | { readonly props: unknown; readonly degraded: false }
  | {
      readonly props: unknown;
      readonly degraded: true;
      readonly reason: string;
    };

/**
 * Resolves the upcaster chain from `storedVersion` to
 * `definition.schemaVersion`, applying each step in order. Returns the
 * stored `props` untouched, flagged `degraded` with a reason, on any of
 * three paths: `storedVersion` is under `definition.minSupportedVersion`
 * (`'below-floor'`, D-15); a step in the chain is missing
 * (`'no-upcaster'`, D-12); or a step throws (`'upcaster-threw: <message>'`,
 * D-12). `storedVersion === definition.schemaVersion` is the identity case
 * -- returned as-is, not degraded.
 */
export function upcastOnRead(
  definition: BlockDefinition,
  storedVersion: number,
  props: unknown,
): UpcastResult {
  if (storedVersion === definition.schemaVersion) {
    return { props, degraded: false };
  }
  if (
    definition.minSupportedVersion !== undefined &&
    storedVersion < definition.minSupportedVersion
  ) {
    return { props, degraded: true, reason: 'below-floor' };
  }

  let current: unknown = props;
  for (
    let version = storedVersion;
    version < definition.schemaVersion;
    version += 1
  ) {
    const step = definition.upcasters[version + 1];
    if (step === undefined) {
      return { props, degraded: true, reason: 'no-upcaster' };
    }
    try {
      current = step(current, version);
    } catch (error) {
      return {
        props,
        degraded: true,
        reason: `upcaster-threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { props: current, degraded: false };
}
