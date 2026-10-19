/**
 * The one href policy. The server validator, the editor's link handling, the
 * CTA popover and the renderer all call `isAllowedHref`, so a target is
 * either acceptable everywhere or nowhere.
 */

export const HREF_MAX_LENGTH = 2048;

const UNICODE_WHITESPACE = /\s/u;

/** Whitespace of any kind, ASCII and C1 control characters, and DEL. */
function hasForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return UNICODE_WHITESPACE.test(value);
}
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const WEB_URL = /^https?:\/\//i;

function isAllowedWebUrl(value: string): boolean {
  if (!WEB_URL.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * True for `https:` and `http:` URLs with a host, `mailto:` and `tel:`
 * targets with something after the scheme, root-relative paths (`/x`, never
 * `//x`) and `#` fragments, up to `HREF_MAX_LENGTH` characters with no
 * whitespace or control characters. Every other scheme (`javascript:`,
 * `data:`, `vbscript:`, ...) is refused.
 */
export function isAllowedHref(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > HREF_MAX_LENGTH) return false;
  if (hasForbiddenCharacter(value)) return false;

  if (value.startsWith('#')) return true;
  if (value.startsWith('/')) {
    return !value.startsWith('//') && !value.startsWith('/\\');
  }

  const scheme = SCHEME.exec(value);
  if (scheme === null) return false;
  switch ((scheme[1] ?? '').toLowerCase()) {
    case 'http':
    case 'https':
      return isAllowedWebUrl(value);
    case 'mailto':
    case 'tel':
      return value.length > scheme[0].length;
    default:
      return false;
  }
}
