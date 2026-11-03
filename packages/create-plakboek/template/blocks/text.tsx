import { defineBlock } from '@plakboek/core';
import { RichText, type BlockComponent } from '@plakboek/render';

type TextProps = {
  body?: unknown;
};

// A plain function component: the visitor renderer rejects memo and
// forwardRef wrappers. `edit.field('body')` on the root makes the text
// editable on the page itself. RichText adds no wrapper of its own, so the
// root element below is the only element around the paragraphs. An empty text
// keeps a one-line box (24px: one empty paragraph of the body text) to click
// and to show the editor's hint in; the editor's empty paragraph fills exactly
// that line, so nothing moves when typing starts.
const Text: BlockComponent<TextProps> = ({ props, edit }) => (
  <div {...edit} {...edit.field('body')} className="min-h-6 space-y-4">
    <RichText value={props.body} />
  </div>
);

export const text = defineBlock({
  key: 'text',
  editor: { label: 'Text' },
  schemaVersion: 1,
  properties: {
    body: {
      fieldType: 'rich_text',
      label: 'Text',
      // An empty Text then shows Needs input on the page and in the Page
      // structure tree.
      required: true,
    },
  },
  component: Text,
});
