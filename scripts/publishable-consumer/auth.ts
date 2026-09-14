import {
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  assertPasswordPolicy,
} from '@plakboek/auth';

if (typeof assertPasswordPolicy !== 'function') {
  process.exit(1);
}

if (typeof PasswordPolicyError !== 'function') {
  process.exit(1);
}

if (typeof PASSWORD_MIN_LENGTH !== 'number') {
  process.exit(1);
}

function minLengthOf(error: PasswordPolicyError): number {
  return error.minLength;
}

// Must not open a connection or send anything: only the type-of checks and
// type assignments above.
console.log(
  'auth.ts: assertPasswordPolicy/PasswordPolicyError/PASSWORD_MIN_LENGTH are exported (no connection opened, nothing sent)',
  typeof minLengthOf,
  PASSWORD_MIN_LENGTH,
);
