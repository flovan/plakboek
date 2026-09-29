/**
 * Generic warning-hook invocation (D-17, D-15), extracted to its own
 * dependency-free leaf module so both `config.ts` and any module
 * `definePagesConfig` itself needs to call into at boot (`section-lint.ts`)
 * can import it without a `config.ts <-> section-lint.ts` circular value
 * import -- the same reason `field-type-ids.ts` was extracted from
 * `registry.ts` (STATE.md, Phase 4 quick task 260923-vxy). `config.ts`
 * re-exports `reportPagesWarning` unchanged, so every existing
 * `from './config.js'` import keeps resolving.
 */

/**
 * Invokes a warning hook (or its fallback) inside a try/catch, handling a
 * hook that returns a rejected promise the same way
 * `@plakboek/content`'s `reportContentWarning` does -- a broken or slow
 * host-supplied hook can never crash the operation it is reporting on.
 */
export function reportPagesWarning<E>(
  hook: ((event: E) => void) | undefined,
  fallback: (event: E) => void,
  event: E,
): void {
  const invoke = hook ?? fallback;
  try {
    const returned: unknown = invoke(event);
    if (
      typeof returned === 'object' &&
      returned !== null &&
      typeof Reflect.get(returned, 'then') === 'function'
    ) {
      void Promise.resolve(returned).catch((hookError: unknown) => {
        logHookFailure(hookError);
      });
    }
  } catch (hookError) {
    logHookFailure(hookError);
  }
}

function logHookFailure(hookError: unknown): void {
  try {
    // oxlint-disable-next-line no-console -- last-resort fallback when a host-supplied pages warning hook itself throws or rejects
    console.error('[@plakboek/pages] a warning hook threw', hookError);
  } catch {
    // Never let a broken console/logger escape either.
  }
}
