/**
 * The shape of a theme token name: a lowercase identifier a palette entry,
 * a size entry or a CTA variant is addressed by. Stored documents carry the
 * token, never the CSS behind it, so this pattern is also what keeps a
 * stored value from smuggling anything into a stylesheet.
 */
export const TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
