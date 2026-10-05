export const TEST_EMAIL_TOKEN_TTL_MS = 0;

export type VerifiedTestEmailToken = {
  readonly userId: string;
  readonly homePublished: boolean;
  readonly tokenId: string;
};

export function createTestEmailToken(_options: {
  readonly secret: string;
  readonly userId: string;
  readonly homePublished: boolean;
  readonly now?: number;
}): string {
  return '';
}

export function verifyTestEmailToken(
  _token: string,
  _options: { readonly secret: string; readonly now?: number },
): VerifiedTestEmailToken | null {
  return { userId: '', homePublished: false, tokenId: '' };
}

export type SendLimiter = {
  consume(tokenId: string): boolean;
  size(): number;
};

export function createSendLimiter(_options: {
  readonly max?: number;
  readonly maxEntries?: number;
}): SendLimiter {
  return { consume: () => true, size: () => 0 };
}
