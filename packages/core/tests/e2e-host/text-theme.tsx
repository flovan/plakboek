import { defineTextTheme } from '@plakboek/render';

/**
 * The e2e host's text theme: a small palette, one size, alignment and two
 * button looks, with every mark and node the default theme allows. Its
 * renderers carry classes and its stylesheet (public/theme.css) spaces them
 * with margins, so an editor that did not render through them would move the
 * text it edits.
 */
export default defineTextTheme({
  colors: [
    { label: 'Accent', token: 'accent' },
    { label: 'Muted', token: 'text-muted' },
  ],
  sizes: [{ label: 'Large', token: 'xl' }],
  align: true,
  ctaVariants: [
    { label: 'Primary', value: 'primary' },
    { label: 'Secondary', value: 'secondary' },
  ],
  renderers: {
    paragraph: ({ children, textAlign }) => (
      <p className="t-p" style={textAlign === null ? undefined : { textAlign }}>
        {children}
      </p>
    ),
    heading: ({ level, textAlign, children }) => {
      const style = textAlign === null ? undefined : { textAlign };
      if (level === 3) {
        return (
          <h3 className="t-h3" style={style}>
            {children}
          </h3>
        );
      }
      if (level === 4) {
        return (
          <h4 className="t-h4" style={style}>
            {children}
          </h4>
        );
      }
      return (
        <h2 className="t-h2" style={style}>
          {children}
        </h2>
      );
    },
    bulletList: ({ children }) => <ul className="t-ul">{children}</ul>,
    orderedList: ({ start, children }) => (
      <ol className="t-ol" start={start === 1 ? undefined : start}>
        {children}
      </ol>
    ),
    listItem: ({ children }) => <li className="t-li">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="t-quote">{children}</blockquote>
    ),
  },
});
