/**
 * Defence in depth for pasted HTML. The locked schema is what decides what a
 * paste can become (only theme nodes and marks, no attribute that is not in
 * the stored shape), and the server checks every write again. These two
 * functions work on the clipboard's HTML string, so they run anywhere:
 *
 * - `cleanPastedHtml` strips what is never wanted before the editor reads it:
 *   inline styles, classes, ids, language and direction hints, event handler
 *   attributes, scripts, stylesheets, comments, and the wrappers Word and web
 *   pages add (`font`, `o:p`). It keeps tags and text, and puts a space after
 *   each table cell, which the schema flattens into running text.
 * - `pasteLostFormatting` says whether the paste carried something the theme
 *   cannot keep, so the editor can tell the author formatting was dropped.
 */

/** Elements dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set(['style', 'script', 'title', 'xml']);

/** Elements dropped on their own; their text stays. */
const UNWRAP = new Set(['font']);

/** Elements dropped without content (they have none). */
const DROP_VOID = new Set(['meta', 'link']);

const STRIPPED_ATTRIBUTES = new Set(['style', 'class', 'id', 'lang', 'dir']);

/** What the editor's own copy carries: a paste of it lost nothing. */
const OWN_SLICE = 'data-pm-slice';

/**
 * A tag at the scan position: name and the attribute text, where an attribute
 * value in quotes may hold a greater-than sign.
 */
const TAG = /<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/y;
const DECLARATION = /<[!?][^>]*>/y;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;

type Token =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tag';
      readonly closing: boolean;
      readonly name: string;
      readonly attributes: readonly { name: string; source: string }[];
      readonly selfClosing: boolean;
    };

function attributesOf(
  source: string,
): readonly { name: string; source: string }[] {
  const found: { name: string; source: string }[] = [];
  for (const match of source.matchAll(ATTRIBUTE)) {
    found.push({ name: (match[1] ?? '').toLowerCase(), source: match[0] });
  }
  return found;
}

/**
 * Splits HTML into text and tags. Comments, declarations and conditional
 * comments are dropped here; the content of a script or stylesheet is dropped
 * with its element.
 */
function tokenize(html: string): readonly Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let skipUntil: string | null = null;
  while (at < html.length) {
    const lt = html.indexOf('<', at);
    if (lt === -1) {
      if (skipUntil === null) {
        tokens.push({ kind: 'text', text: html.slice(at) });
      }
      break;
    }
    if (lt > at && skipUntil === null) {
      tokens.push({ kind: 'text', text: html.slice(at, lt) });
    }
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    DECLARATION.lastIndex = lt;
    if (DECLARATION.test(html)) {
      at = DECLARATION.lastIndex;
      continue;
    }
    TAG.lastIndex = lt;
    const match = TAG.exec(html);
    if (match === null) {
      // A lone `<` that opens no tag is text.
      if (skipUntil === null) tokens.push({ kind: 'text', text: '<' });
      at = lt + 1;
      continue;
    }
    at = TAG.lastIndex;
    const closing = match[1] === '/';
    const name = (match[2] ?? '').toLowerCase();
    const rest = match[3] ?? '';
    if (skipUntil !== null) {
      if (closing && name === skipUntil) skipUntil = null;
      continue;
    }
    const selfClosing = rest.trimEnd().endsWith('/');
    if (!closing && !selfClosing && DROP_WITH_CONTENT.has(name)) {
      skipUntil = name;
      continue;
    }
    tokens.push({
      kind: 'tag',
      closing,
      name,
      attributes: closing ? [] : attributesOf(rest),
      selfClosing,
    });
  }
  return tokens;
}

/** True for a tag name with a namespace, like Word's `o:p` or `w:sdt`. */
function isNamespaced(name: string): boolean {
  return name.includes(':');
}

function keepsAttribute(name: string): boolean {
  return !STRIPPED_ATTRIBUTES.has(name) && !name.startsWith('on');
}

export function cleanPastedHtml(html: string): string {
  let out = '';
  for (const token of tokenize(html)) {
    if (token.kind === 'text') {
      out += token.text;
      continue;
    }
    const { name } = token;
    if (
      DROP_WITH_CONTENT.has(name) ||
      DROP_VOID.has(name) ||
      UNWRAP.has(name) ||
      isNamespaced(name)
    ) {
      continue;
    }
    if (token.closing) {
      out += name === 'td' || name === 'th' ? ` </${name}>` : `</${name}>`;
      continue;
    }
    const kept = token.attributes
      .filter((attribute) => keepsAttribute(attribute.name))
      .map((attribute) => ` ${attribute.source}`)
      .join('');
    out += `<${name}${kept}${token.selfClosing ? ' /' : ''}>`;
  }
  return out;
}

/** Elements a paste can carry that the theme cannot keep as they are. */
const LOSSY_TAGS = new Set([
  'font',
  'h1',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'img',
  'picture',
  'svg',
  'video',
  'audio',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'pre',
  'code',
  'sub',
  'sup',
  'mark',
]);

export function pasteLostFormatting(html: string): boolean {
  if (html.includes(OWN_SLICE)) return false;
  for (const token of tokenize(html)) {
    if (token.kind !== 'tag' || token.closing) continue;
    if (LOSSY_TAGS.has(token.name) || isNamespaced(token.name)) return true;
    for (const attribute of token.attributes) {
      if (attribute.name === 'style') return true;
      if (attribute.name === 'class' && /mso/i.test(attribute.source)) {
        return true;
      }
    }
  }
  return false;
}
