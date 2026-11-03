import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RichTextIssueEvent } from '../../src/hooks.js';
import { defineTextTheme } from '../../src/rich-text/define-text-theme.js';
import {
  createTextEnvironment,
  TextEnvironmentProvider,
  type TextEnvironmentInput,
} from '../../src/rich-text/environment.js';
import { RichText } from '../../src/rich-text/rich-text.js';

type Json = Record<string, unknown>;

function text(value: string, marks?: Json[]): Json {
  return marks === undefined
    ? { type: 'text', text: value }
    : { type: 'text', text: value, marks };
}

function doc(...content: Json[]): Json {
  return { type: 'doc', content };
}

function paragraph(...content: Json[]): Json {
  return { type: 'paragraph', content };
}

function render(value: unknown, environment?: TextEnvironmentInput): string {
  const field: ReactNode = createElement(RichText, { value });
  return renderToStaticMarkup(
    environment === undefined
      ? field
      : createElement(
          TextEnvironmentProvider,
          { environment: createTextEnvironment(environment) },
          field,
        ),
  );
}

describe('RichText with the default renderers', () => {
  it('nests marks in stored order, first mark outermost', () => {
    const value = doc(
      paragraph(text('hi', [{ type: 'bold' }, { type: 'italic' }])),
    );
    expect(render(value)).toBe('<p><strong><em>hi</em></strong></p>');
  });

  it('renders no wrapper element around the top-level nodes', () => {
    const value = doc(paragraph(text('one')), paragraph(text('two')));
    expect(render(value)).toBe('<p>one</p><p>two</p>');
  });

  it('renders a heading level through h2, h3 or h4', () => {
    const heading = (level: number): Json => ({
      type: 'heading',
      attrs: { level },
      content: [text('t')],
    });
    expect(render(doc(heading(3)))).toBe('<h3>t</h3>');
    expect(render(doc(heading(4)))).toBe('<h4>t</h4>');
  });

  it.each([null, undefined, 'text', 7, {}, { type: 'paragraph' }])(
    'renders nothing for %j',
    (value) => {
      expect(render(value)).toBe('');
    },
  );
});

describe('RichText with a host renderer override', () => {
  it('renders through the overriding heading renderer', () => {
    const definition = defineTextTheme({
      renderers: {
        heading: ({ level, children }) => {
          const Tag = level === 3 ? 'h3' : level === 4 ? 'h4' : 'h2';
          return createElement(Tag, { className: `t-${level}` }, children);
        },
      },
    });
    const value = doc({
      type: 'heading',
      attrs: { level: 4 },
      content: [text('Sub')],
    });
    expect(render(value, { definition })).toBe('<h4 class="t-4">Sub</h4>');
  });
});

const PAGE_ID = '0b5f4c1e-3c52-4a53-9a61-2f2b9d0f7c11';

function markedText(value: string, mark: Json): Json {
  return text(value, [mark]);
}

/** The environment input that records every reported issue. */
function recording(extra: TextEnvironmentInput = {}): {
  input: TextEnvironmentInput;
  issues: RichTextIssueEvent[];
} {
  const issues: RichTextIssueEvent[] = [];
  return {
    issues,
    input: {
      ...extra,
      hooks: { onRichTextIssue: (event) => issues.push(event) },
    },
  };
}

function cta(attrs: Json): Json {
  return { type: 'cta', attrs };
}

type Fixtures = {
  themes: Record<string, Parameters<typeof defineTextTheme>[0]>;
  valid: { name: string; theme: string; doc: unknown }[];
};

const fixtures: Fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../content/tests/fixtures/rich-text/shapes.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

describe('every valid stored shape', () => {
  it.each(fixtures.valid.map((entry) => [entry.name, entry] as const))(
    'renders %s without throwing',
    (_name, entry) => {
      const definition = defineTextTheme(fixtures.themes[entry.theme]);
      const html = render(entry.doc, {
        definition,
        resolvePage: () => '/somewhere',
      });
      expect(html).not.toContain('<script');
    },
  );
});

describe('headings', () => {
  it('renders a stored level 1 as h2 and reports it once', () => {
    const { input, issues } = recording();
    const heading: Json = {
      type: 'heading',
      attrs: { level: 1 },
      content: [text('Big')],
    };
    const html = render(doc(heading, heading), input);
    expect(html).toBe('<h2>Big</h2><h2>Big</h2>');
    expect(issues).toEqual([{ kind: 'node', name: 'heading' }]);
  });
});

describe('links', () => {
  const link = (attrs: Json): Json => markedText('go', { type: 'link', attrs });
  const linked = (attrs: Json, input?: TextEnvironmentInput): string =>
    render(doc(paragraph(link(attrs))), input);

  it('adds rel for a new tab', () => {
    expect(
      linked({ href: 'https://x.test', pageId: null, target: '_blank' }),
    ).toBe(
      '<p><a href="https://x.test" target="_blank" rel="noopener noreferrer">go</a></p>',
    );
  });

  it('renders the path the environment resolves for a page id', () => {
    expect(
      linked(
        { href: null, pageId: PAGE_ID, target: null },
        { resolvePage: (id) => (id === PAGE_ID ? '/about' : null) },
      ),
    ).toBe('<p><a href="/about">go</a></p>');
  });

  it('renders the text unlinked for an unknown page id, a script href or no resolver', () => {
    expect(linked({ href: null, pageId: PAGE_ID, target: null })).toBe(
      '<p>go</p>',
    );
    expect(
      linked({ href: 'javascript:alert(1)', pageId: null, target: null }),
    ).toBe('<p>go</p>');
  });

  it('refuses a resolved path the href policy refuses', () => {
    expect(
      linked(
        { href: null, pageId: PAGE_ID, target: null },
        { resolvePage: () => 'javascript:alert(1)' },
      ),
    ).toBe('<p>go</p>');
  });

  it('survives a resolver that throws', () => {
    expect(
      linked(
        { href: null, pageId: PAGE_ID, target: null },
        {
          resolvePage: () => {
            throw new Error('boom');
          },
        },
      ),
    ).toBe('<p>go</p>');
  });
});

describe('colour and size marks', () => {
  const styled = (mark: Json): string =>
    render(doc(paragraph(markedText('x', mark))));

  it('renders a token as a theme variable and a literal as itself', () => {
    expect(
      styled({ type: 'textColor', attrs: { token: 'accent', value: null } }),
    ).toBe('<p><span style="color:var(--color-accent)">x</span></p>');
    expect(
      styled({ type: 'textColor', attrs: { token: null, value: '#1d4ed8' } }),
    ).toBe('<p><span style="color:#1d4ed8">x</span></p>');
    expect(
      styled({ type: 'textSize', attrs: { token: 'xl', value: null } }),
    ).toBe('<p><span style="font-size:var(--text-xl)">x</span></p>');
    expect(
      styled({ type: 'textSize', attrs: { token: null, value: '18px' } }),
    ).toBe('<p><span style="font-size:18px">x</span></p>');
  });

  it.each([
    { type: 'textColor', attrs: { token: 'a;b', value: null } },
    { type: 'textColor', attrs: { token: null, value: 'red;x' } },
    { type: 'textColor', attrs: { token: null, value: 'url(x)' } },
    { type: 'textSize', attrs: { token: 'a;b', value: null } },
    { type: 'textSize', attrs: { token: null, value: '18px;x' } },
    { type: 'textSize', attrs: { token: null, value: '400px' } },
    { type: 'textColor', attrs: { token: null, value: null } },
  ])('drops the mark and keeps the text for %j', (mark) => {
    expect(styled(mark)).toBe('<p>x</p>');
  });
});

describe('call to action', () => {
  const complete = (label: string, href: string): Json =>
    cta({ label, href, pageId: null, target: null, variant: 'primary' });

  it('groups adjacent CTAs into one row between the surrounding nodes', () => {
    const html = render(
      doc(
        paragraph(text('before')),
        complete('One', '/one'),
        complete('Two', '/two'),
        paragraph(text('after')),
      ),
    );
    expect(html).toBe(
      '<p>before</p><div data-cta-row=""><a href="/one" data-variant="primary">One</a><a href="/two" data-variant="primary">Two</a></div><p>after</p>',
    );
  });

  it('closes the row at any other node', () => {
    const html = render(
      doc(
        complete('One', '/one'),
        paragraph(text('between')),
        complete('Two', '/two'),
      ),
    );
    expect(html.match(/data-cta-row/g)).toHaveLength(2);
  });

  it('renders an unfinished CTA for an editor only, without an href', () => {
    const unfinished = cta({
      label: '',
      href: null,
      pageId: null,
      target: null,
      variant: 'primary',
    });
    expect(render(doc(unfinished))).toBe('');
    expect(render(doc(unfinished), { mode: 'edit' })).toBe(
      '<div data-cta-row=""><span data-variant="primary"></span></div>',
    );
  });
});

describe('what the renderer does not know', () => {
  it('keeps the text of an unknown node and reports it once', () => {
    const { input, issues } = recording();
    const unknown: Json = { type: 'image', content: [text('alt words')] };
    expect(render(doc(unknown, unknown), input)).toBe('alt wordsalt words');
    expect(issues).toEqual([{ kind: 'node', name: 'image' }]);
  });

  it('drops an unknown mark, keeps the text and reports it once', () => {
    const { input, issues } = recording();
    const marked = markedText('kept', { type: 'highlight' });
    expect(render(doc(paragraph(marked, marked)), input)).toBe(
      '<p>keptkept</p>',
    );
    expect(issues).toEqual([{ kind: 'mark', name: 'highlight' }]);
  });

  it('survives a hook that throws', () => {
    const html = render(doc({ type: 'image', content: [text('ok')] }), {
      hooks: {
        onRichTextIssue: () => {
          throw new Error('hook');
        },
      },
    });
    expect(html).toBe('ok');
  });
});

describe('the editor trailing paragraph', () => {
  it('is not rendered, but an empty paragraph in the middle is', () => {
    const html = render(
      doc(
        paragraph(text('one')),
        { type: 'paragraph' },
        paragraph(text('two')),
        { type: 'paragraph' },
      ),
    );
    expect(html).toBe('<p>one</p><p></p><p>two</p>');
  });
});
