/**
 * Redaction of sensitive values in audit payloads. Skeleton only: the
 * behaviour lands with the implementation commit.
 */
export const REDACTION_MARKER = '[redacted]';

export const REDACTED_KEYS: readonly string[] = Object.freeze([]);

export function redactAuditPayload(
  value: unknown,
  _options?: { readonly maxDepth?: number },
): unknown {
  return value;
}
