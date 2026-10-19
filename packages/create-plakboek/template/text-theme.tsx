import { defineTextTheme } from '@plakboek/render';

// The one text theme of the site. It says what an editor may do in a rich text
// field and how each piece of text looks. `plakboek.config.ts` passes it to
// defineConfig and the Vite plugin finds this file by its name, so the server
// and the page editor read the same value. Keep the imports to `react` and
// `@plakboek/render`: this module also loads in the editor's own chunk.

// How a heading looks, by level. The Heading block uses the same classes, so a
// heading typed in a Text block and a Heading block are indistinguishable.
export const HEADING_CLASS: Record<2 | 3 | 4, string> = {
  2: 'text-3xl font-semibold mt-6 first:mt-0 mb-2',
  3: 'text-xl font-semibold mt-6 first:mt-0 mb-2',
  4: 'text-base font-semibold mt-6 first:mt-0 mb-2',
};

// A token starts with a letter, so the 28px size cannot be called `3xl`; it is
// `display` here and reads the `--text-3xl` variable. Any other size token
// reads the variable of the same name.
const SIZE_VARIABLE: Record<string, string> = { display: '--text-3xl' };

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2';

const CTA_BASE = `inline-flex min-h-11 max-w-full items-center justify-center rounded-lg border px-6 py-2 text-center text-base font-semibold wrap-anywhere focus-visible:outline-accent ${FOCUS}`;

const CTA_CLASS: Record<string, string> = {
  primary: `${CTA_BASE} border-accent bg-accent text-surface hover:bg-[color-mix(in_srgb,var(--color-accent)_85%,black)]`,
  secondary: `${CTA_BASE} border-text bg-transparent text-text hover:bg-surface-muted`,
};

export default defineTextTheme({
  // Palette entries name the tokens of app/app.css. The editor shows the
  // labels and never the token names.
  colors: [
    { label: 'Text', token: 'text' },
    { label: 'Muted', token: 'text-muted' },
    { label: 'Accent', token: 'accent' },
  ],
  sizes: [
    { label: 'Small', token: 'sm', value: '14px' },
    { label: 'Large', token: 'xl', value: '20px' },
    { label: 'Extra large', token: 'display', value: '28px' },
  ],
  align: true,
  // Custom colours, sizes and alignment render inline style attributes. A host
  // with a strict style-src sets this to false and overrides the colour, size
  // and paragraph renderers below to emit classes.
  allowCustomValues: true,
  ctaVariants: [
    { label: 'Primary', value: 'primary' },
    { label: 'Secondary', value: 'secondary' },
  ],

  // Override one renderer at a time; every renderer you leave out keeps its
  // default. Each renders its children inside exactly one element.
  renderers: {
    paragraph: ({ children, textAlign }) => (
      <p
        className="text-base text-text"
        style={textAlign === null ? undefined : { textAlign }}
      >
        {children}
      </p>
    ),
    heading: ({ level, textAlign, children }) => {
      const Tag = level === 3 ? 'h3' : level === 4 ? 'h4' : 'h2';
      return (
        <Tag
          className={HEADING_CLASS[level]}
          style={textAlign === null ? undefined : { textAlign }}
        >
          {children}
        </Tag>
      );
    },
    textSize: ({ token, value, children }) => (
      <span
        style={{
          fontSize:
            token === null
              ? (value ?? undefined)
              : `var(${SIZE_VARIABLE[token] ?? `--text-${token}`})`,
        }}
      >
        {children}
      </span>
    ),
    bold: ({ children }) => (
      <strong className="font-semibold">{children}</strong>
    ),
    link: ({ href, target, children }) => (
      <a
        href={href}
        target={target ?? undefined}
        rel={target === '_blank' ? 'noopener noreferrer' : undefined}
        className={`text-accent underline underline-offset-2 focus-visible:outline-accent ${FOCUS}`}
      >
        {children}
      </a>
    ),
    bulletList: ({ children }) => (
      <ul className="list-disc space-y-1 pl-6">{children}</ul>
    ),
    orderedList: ({ start, children }) => (
      <ol
        start={start === 1 ? undefined : start}
        className="list-decimal space-y-1 pl-6"
      >
        {children}
      </ol>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-6 border-l-4 border-border pl-4 text-text-muted">
        {children}
      </blockquote>
    ),
    horizontalRule: () => <hr className="my-6 border-border" />,
    cta: ({ label, href, target, variant }) => {
      const className = CTA_CLASS[variant] ?? CTA_CLASS.primary;
      return href === null ? (
        <span className={className}>{label}</span>
      ) : (
        <a
          href={href}
          target={target ?? undefined}
          rel={target === '_blank' ? 'noopener noreferrer' : undefined}
          className={className}
        >
          {label}
        </a>
      );
    },
    ctaRow: ({ children }) => (
      <div className="flex flex-wrap gap-4">{children}</div>
    ),
  },
});
