import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PropertyField } from '../../src/chrome/editing/properties/controls.js';
import { STRINGS } from '../../src/chrome/strings.js';

/** What `renderToStaticMarkup` makes of a text, so a string can be looked for in the markup. */
function escaped(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

function render(fieldType: string, value: unknown): string {
  return renderToStaticMarkup(
    createElement(PropertyField, {
      fieldKey: 'brand',
      label: 'Brand colour',
      source: { fieldType, widget: 'host-colour-wheel', options: {} },
      required: false,
      value,
      needsInput: false,
      error: null,
      onChange: () => undefined,
      onBlur: () => undefined,
    }),
  );
}

describe('PropertyField for a widget the editor has no control for', () => {
  it('draws a host field type as the JSON textarea holding the value pretty-printed, with its note and hint', () => {
    const markup = render('host_colour', { a: 1 });
    expect(markup).toContain('<textarea');
    expect(markup).toContain(escaped(JSON.stringify({ a: 1 }, null, 2)));
    expect(markup).toContain('autoCorrect="off"');
    expect(markup).toContain('autoCapitalize="off"');
    expect(markup).toContain(escaped(STRINGS['panel.customWidgetJsonNote']));
    expect(markup).toContain(escaped(STRINGS['panel.jsonFallbackHint']));
    expect(markup).not.toContain(escaped(STRINGS['panel.customWidgetNote']));
  });

  it('leaves the JSON textarea empty without a value, and still shows the note and hint', () => {
    const markup = render('host_colour', undefined);
    expect(markup).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(markup).toContain(escaped(STRINGS['panel.customWidgetJsonNote']));
    expect(markup).toContain(escaped(STRINGS['panel.jsonFallbackHint']));
  });

  it('draws a short_text property as a text input showing its value, with the stand-in note and no JSON hint', () => {
    const markup = render('short_text', '#ff0000');
    expect(markup).toContain('type="text"');
    expect(markup).toContain('value="#ff0000"');
    expect(markup).not.toContain('<textarea');
    expect(markup).toContain(escaped(STRINGS['panel.customWidgetNote']));
    expect(markup).not.toContain(escaped(STRINGS['panel.jsonFallbackHint']));
    expect(markup).not.toContain(
      escaped(STRINGS['panel.customWidgetJsonNote']),
    );
  });

  it('draws a rich_text property as its read-only note, with a note that no standard field stands in', () => {
    const markup = render('rich_text', undefined);
    expect(markup).toContain(escaped(STRINGS['panel.richTextNote']));
    expect(markup).not.toContain('<textarea');
    expect(markup).toContain(escaped(STRINGS['panel.customWidgetNoteOnly']));
    expect(markup).not.toContain(escaped(STRINGS['panel.customWidgetNote']));
  });
});
