import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
