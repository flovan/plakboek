/**
 * Taking the token out of an emailed link. A link carries its single-use
 * token in the query (`/cms/reset-password?token=...&next=...`), and a token
 * left in the address bar ends up in the browser history, in a copied address
 * and, for anything the page loads afterwards, in a Referer header. The card
 * therefore reads it once and replaces the history entry with the same
 * address without it; from then on the token lives only in the component that
 * will send it.
 */

/** The query parameter an emailed link carries its token in. */
export const LINK_TOKEN_PARAMETER = 'token';

/** The part of the browser `takeLinkToken` works on, replaceable in a test. */
export type LinkTokenEnvironment = {
  readonly location: { readonly href: string };
  readonly history: Pick<History, 'state' | 'replaceState'>;
};

/**
 * Returns the link's token and removes it from the address, or returns
 * `null` when the address carries none (every call after the first). An
 * address without a token parameter is not touched; one with an empty or
 * repeated parameter loses all of it, and the first non-empty value is the
 * token. Every other parameter and the fragment are kept, so `next` still
 * reaches the sign-in that follows.
 */
export function takeLinkToken(
  env: LinkTokenEnvironment = globalThis,
): string | null {
  const url = new URL(env.location.href);
  const values = url.searchParams.getAll(LINK_TOKEN_PARAMETER);
  if (values.length === 0) return null;
  url.searchParams.delete(LINK_TOKEN_PARAMETER);
  env.history.replaceState(
    env.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
  const token = values.find((value) => value !== '');
  return token ?? null;
}
