/** Signing in through the real auth API, for the edit-mode specs. */
import { expect, type Page } from '@playwright/test';
import type { E2eAccount } from './host.ts';

/**
 * Signs `account` in through `/api/auth/sign-in/email`, leaving the session
 * cookie in the page's browser context. The request carries an `Origin`
 * header equal to the site's own, which the auth endpoint checks.
 */
export async function signIn(page: Page, account: E2eAccount): Promise<void> {
  const origin = process.env.E2E_BASE_URL;
  if (origin === undefined || origin.length === 0) {
    throw new Error(
      'E2E_BASE_URL is not set: the e2e global setup did not run',
    );
  }
  const response = await page.request.post('/api/auth/sign-in/email', {
    data: { email: account.email, password: account.password },
    headers: { Origin: origin },
  });
  expect(response.status()).toBe(200);
}
