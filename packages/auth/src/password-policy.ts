// RED-phase skeleton: exports the planned names with no behaviour so the
// unit suite fails on its assertions. Replaced by the GREEN implementation.
export const PASSWORD_MIN_LENGTH = 0;

export class PasswordPolicyError extends Error {
  readonly minLength: number = 0;
}

export function assertPasswordPolicy(_candidate: string): void {
  return undefined;
}
