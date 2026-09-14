/**
 * Key-based redaction of the `before`/`after` payloads an audit row stores
 * (D-05, T-02-26). A caller that forgets to strip a credential is the
 * failure mode this designs against, so the key list is fixed here rather
 * than chosen per call: a field that must be kept can be renamed.
 *
 * Matching ignores case and separators (`password_hash`, `passwordHash`
 * and `PASSWORD-HASH` are one key). A matched key stays in the payload and
 * its whole value -- scalar or structure -- becomes `REDACTION_MARKER`, so
 * the stored row still shows that the field was present and changed.
 *
 * The walk mirrors what JSON serialisation stores, since that is what a
 * JSONB column receives: `toJSON` is honoured and its result walked, and
 * only own enumerable string keys are visited.
 */

/** Written in place of every redacted value. */
export const REDACTION_MARKER = '[redacted]';

/** Written in place of an object that is its own ancestor. */
const CYCLE_MARKER = '[circular]';

/** Written in place of a structure nested deeper than `maxDepth`. */
const DEPTH_MARKER = '[truncated]';

const DEFAULT_MAX_DEPTH = 8;

function normaliseKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

/**
 * The normalised forms of every key whose value is never stored in an audit
 * row. Frozen at module load, like the permission catalogue, so no importer
 * can shorten the list at runtime.
 */
export const REDACTED_KEYS: readonly string[] = Object.freeze(
  [
    'password',
    'passwordHash',
    'token',
    'secret',
    'backupCodes',
    'sessionToken',
    'apiKey',
    'otp',
    'code',
    'twoFactorSecret',
    // better-auth's `account` row carries provider credentials under these.
    'accessToken',
    'refreshToken',
    'idToken',
  ].map(normaliseKey),
);

const REDACTED_KEY_SET: ReadonlySet<string> = new Set(REDACTED_KEYS);

export type RedactAuditPayloadOptions = {
  /** How many nested objects/arrays are walked below the root before the
   * rest is replaced by a marker. Defaults to 8. */
  readonly maxDepth?: number;
};

function isRedactedKey(key: string): boolean {
  return REDACTED_KEY_SET.has(normaliseKey(key));
}

/** What JSON serialisation would store for `value` at property `key`. */
function toSerialisable(value: unknown, key: string): unknown {
  if (typeof value === 'object' && value !== null) {
    const toJSON: unknown = Reflect.get(value, 'toJSON');
    if (typeof toJSON === 'function') {
      return Reflect.apply(toJSON, value, [key]);
    }
  }
  return value;
}

/**
 * Returns a redacted copy of `value`; the input is never mutated.
 * Primitives, `null` and `undefined` come back unchanged. Plain objects and
 * arrays are rebuilt with every sensitive key's value replaced, a cycle
 * replaced by `'[circular]'`, and anything below `maxDepth` replaced by
 * `'[truncated]'`.
 */
export function redactAuditPayload(
  value: unknown,
  options?: RedactAuditPayloadOptions,
): unknown {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError(
      '@plakboek/auth: redactAuditPayload maxDepth must be a non-negative integer',
    );
  }

  // Only the current path is tracked: an object reached again through a
  // sibling is a shared reference and is walked again, one reached again
  // through its own descendants is a cycle.
  const ancestors = new WeakSet<object>();

  function walk(input: unknown, key: string, depth: number): unknown {
    const node = toSerialisable(input, key);
    if (typeof node !== 'object' || node === null) {
      return node;
    }
    if (ancestors.has(node)) {
      return CYCLE_MARKER;
    }
    if (depth >= maxDepth) {
      return DEPTH_MARKER;
    }

    ancestors.add(node);
    try {
      if (Array.isArray(node)) {
        return node.map((item: unknown, index) =>
          walk(item, String(index), depth + 1),
        );
      }
      // Object.fromEntries defines each key as an own data property, so a
      // "__proto__" key stays data instead of replacing the prototype.
      return Object.fromEntries(
        Object.keys(node).map((childKey) => [
          childKey,
          isRedactedKey(childKey)
            ? REDACTION_MARKER
            : walk(Reflect.get(node, childKey), childKey, depth + 1),
        ]),
      );
    } finally {
      ancestors.delete(node);
    }
  }

  return walk(value, '', 0);
}
