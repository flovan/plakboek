// RED skeleton: the exports exist so the suite loads; the behaviour is not
// implemented yet.
export const TWO_FACTOR_REQUIRED_ROLE_KEYS: readonly string[] = [];

export const TWO_FACTOR_ENROLMENT_PATH = '';

export type TwoFactorSubject = {
  readonly roleKey: string;
  readonly twoFactorEnabled: boolean;
};

export class TwoFactorEnrolmentRequiredError extends Error {
  readonly redirectTo: string = '';
  readonly roleKey: string = '';
}

export function isTwoFactorRequiredForRole(_roleKey: string): boolean {
  return false;
}

export function needsTwoFactorEnrolment(_subject: TwoFactorSubject): boolean {
  return false;
}

export function assertTwoFactorSatisfied(subject: TwoFactorSubject): void {
  void subject;
}
