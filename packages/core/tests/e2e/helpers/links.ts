/**
 * Emailed links for the specs. The e2e host sends no mail, so a spec asks the
 * same auth engine the server runs for a link and reads it from a mail sender
 * that records instead of sending. Both engines share the throwaway database,
 * so a link issued here is one the running server accepts, once.
 */
import { createAuth, requestPasswordLink } from '@plakboek/auth';
import type { MailMessage, MailSender } from '@plakboek/auth';
import { closeAllDbs, getDb } from '../../../src/runtime/db.ts';
import { readRuntimeEnv } from '../../../src/runtime/env.ts';

/** A sender that keeps every message it is given. */
function capturingMail(): {
  readonly sender: MailSender;
  readonly sent: MailMessage[];
} {
  const sent: MailMessage[] = [];
  return {
    sender: {
      send(message) {
        sent.push(message);
        return Promise.resolve();
      },
    },
    sent,
  };
}

/** The one absolute link a message carries, from its plain-text part. */
function linkOf(message: MailMessage | undefined): string {
  const link = message?.text.match(/https?:\/\/[^\s<>"')\]]+/)?.[0];
  if (link === undefined) {
    throw new Error('The captured message carries no link');
  }
  return link;
}

/** The link as a path and query on the running site, so a browser that
 * navigates to it is served by the e2e server whatever host the message
 * names. */
function onSite(link: string): string {
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
}

/**
 * The link an emailed reset (`reset-password`) or invitation (`set-password`)
 * carries for `email`, with `next` in it, as a site-relative address. The link
 * is single use and lives on the server's database like any other.
 */
export async function issuePasswordLink(
  email: string,
  purpose: 'set-password' | 'reset-password',
  next: string,
): Promise<string> {
  const env = readRuntimeEnv(process.env);
  const { sender, sent } = capturingMail();
  try {
    await requestPasswordLink(
      {
        db: getDb(env.databaseUrl).db,
        mail: sender,
        baseURL: env.siteUrl,
        onDeliveryError: (error) => {
          throw error;
        },
      },
      { email, purpose, next },
    );
    return onSite(linkOf(sent[0]));
  } finally {
    await closeAllDbs();
  }
}

/**
 * The sign-in link the auth engine emails for `email`, as a site-relative
 * address: it lands on `/cms/magic-link?next=...` after the server has spent
 * it, exactly as the modal's own request would.
 */
export async function issueMagicLink(
  email: string,
  next: string,
): Promise<string> {
  const env = readRuntimeEnv(process.env);
  const { default: config } = await import('../../e2e-host/plakboek.config.ts');
  const { sender, sent } = capturingMail();
  try {
    const auth = createAuth({
      db: getDb(env.databaseUrl).db,
      baseURL: env.siteUrl,
      secret: env.secret,
      mail: sender,
      roles: config.roles,
      appName: config.siteName,
      onMailDeliveryError: (error) => {
        throw error;
      },
    });
    const encoded = encodeURIComponent(next);
    await auth.api.signInMagicLink({
      body: {
        email,
        callbackURL: `/cms/magic-link?next=${encoded}`,
        errorCallbackURL: `/cms/magic-link?error=1&next=${encoded}`,
      },
      headers: new Headers({ origin: env.siteUrl }),
    });
    // The send is dispatched, not awaited, so give it a turn to be recorded.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return onSite(linkOf(sent[0]));
  } finally {
    await closeAllDbs();
  }
}
