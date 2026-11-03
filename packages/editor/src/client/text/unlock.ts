/**
 * The unlock set: custom colour and size marks and a paragraph alignment
 * attribute, kept apart from the locked base so that reverting is stripping a
 * mark type. `unlockExtensions(theme)` returns only the parts the theme
 * declares, so a theme without them has no such mark or attribute in its
 * schema and nothing can type, paste or deserialise one.
 *
 * Every parse rule reads its own `data-pk-*` attributes and never `style`, so
 * colours, sizes and alignment pasted from Word or a web page are dropped by
 * construction. A token must match the token pattern (and, when the theme
 * lists a palette, be in it) and a literal must be a hex colour or a whole px
 * size, or no mark is created. Rendering writes a CSS value only for a
 * validated token or literal.
 */
import { Extension, Mark, type Extensions } from '@tiptap/core';
import {
  isCustomColorValue,
  isCustomSizeValue,
  TEXT_ALIGNS,
  TOKEN_PATTERN,
  type TextAlign,
  type TextTheme,
} from '@plakboek/content/rich-text';

type StyleMarkOptions = {
  /** The palette tokens a pasted mark may name; null accepts any well-formed token. */
  tokens: readonly string[] | null;
  /** Whether a literal (hex colour, px size) may be parsed. */
  allowCustomValues: boolean;
};

type StyleMarkSpec = {
  name: 'textColor' | 'textSize';
  /** The marker attribute, with `-token` and `-value` attributes beside it. */
  marker: 'data-pk-color' | 'data-pk-size';
  cssProperty: 'color' | 'font-size';
  /** `var(--<prefix>-<token>)` for a token reference. */
  variablePrefix: 'color' | 'text';
  isLiteral: (value: string) => boolean;
};

type StyleChoice = { token: string | null; value: string | null };

function readChoice(
  element: HTMLElement,
  spec: StyleMarkSpec,
  options: StyleMarkOptions,
): StyleChoice | false {
  const token = element.getAttribute(`${spec.marker}-token`);
  const value = element.getAttribute(`${spec.marker}-value`);
  // Exactly one of the two.
  if ((token === null) === (value === null)) return false;
  if (token !== null) {
    if (!TOKEN_PATTERN.test(token)) return false;
    if (options.tokens !== null && !options.tokens.includes(token)) {
      return false;
    }
    return { token, value: null };
  }
  if (value === null || !options.allowCustomValues || !spec.isLiteral(value)) {
    return false;
  }
  return { token: null, value };
}

/** The attributes and CSS a mark writes; only validated values appear. */
function renderChoice(
  spec: StyleMarkSpec,
  attrs: Record<string, unknown>,
): Record<string, string> {
  const written: Record<string, string> = { [spec.marker]: '' };
  const { token, value } = attrs;
  if (typeof token === 'string' && TOKEN_PATTERN.test(token)) {
    written[`${spec.marker}-token`] = token;
    written.style = `${spec.cssProperty}: var(--${spec.variablePrefix}-${token})`;
  } else if (typeof value === 'string' && spec.isLiteral(value)) {
    written[`${spec.marker}-value`] = value;
    written.style = `${spec.cssProperty}: ${value}`;
  }
  return written;
}

function createStyleMark(spec: StyleMarkSpec) {
  return Mark.create<StyleMarkOptions>({
    name: spec.name,

    addOptions() {
      return { tokens: null, allowCustomValues: true };
    },

    addAttributes() {
      // Not read from a plain `token` or `value` attribute: only the marker's
      // own data attributes (see `parseHTML`) fill them.
      return {
        token: { default: null, rendered: false, parseHTML: () => null },
        value: { default: null, rendered: false, parseHTML: () => null },
      };
    },

    parseHTML() {
      return [
        {
          tag: `span[${spec.marker}]`,
          getAttrs: (node) =>
            readChoice(node as HTMLElement, spec, this.options),
        },
      ];
    },

    renderHTML({ mark }) {
      return ['span', renderChoice(spec, mark.attrs), 0];
    },
  });
}

/** A custom text colour: a palette token or a hex literal, exactly one set. */
export const TextColor = createStyleMark({
  name: 'textColor',
  marker: 'data-pk-color',
  cssProperty: 'color',
  variablePrefix: 'color',
  isLiteral: isCustomColorValue,
});

/** A custom text size: a palette token or a whole px literal, exactly one set. */
export const TextSize = createStyleMark({
  name: 'textSize',
  marker: 'data-pk-size',
  cssProperty: 'font-size',
  variablePrefix: 'text',
  isLiteral: isCustomSizeValue,
});

function readAlign(element: HTMLElement): TextAlign | null {
  const value = element.getAttribute('data-pk-align');
  return (TEXT_ALIGNS as readonly (string | null)[]).includes(value)
    ? (value as TextAlign)
    : null;
}

/** Paragraph and heading alignment, read only from `data-pk-align`. */
export const TextAlignAttribute = Extension.create({
  name: 'textAlign',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element: HTMLElement) => readAlign(element),
            renderHTML: (attributes: Record<string, unknown>) => {
              const align = attributes.textAlign;
              return typeof align === 'string' &&
                (TEXT_ALIGNS as readonly string[]).includes(align)
                ? { 'data-pk-align': align, style: `text-align: ${align}` }
                : {};
            },
          },
        },
      },
    ];
  },
});

/** The unlock extensions the theme declares; empty for a theme that declares none. */
export function unlockExtensions(theme: TextTheme): Extensions {
  const extensions: Extensions = [];
  if (theme.colors.length > 0) {
    extensions.push(
      TextColor.configure({
        tokens: theme.colors.map((entry) => entry.token),
        allowCustomValues: theme.allowCustomValues,
      }),
    );
  }
  if (theme.sizes.length > 0) {
    extensions.push(
      TextSize.configure({
        tokens: theme.sizes.map((entry) => entry.token),
        allowCustomValues: theme.allowCustomValues,
      }),
    );
  }
  if (theme.align) extensions.push(TextAlignAttribute);
  return extensions;
}
