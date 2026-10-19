import { defineBlock } from '@plakboek/core';
import { RichText, type BlockComponent } from '@plakboek/render';

type TextProps = {
  body?: unknown;
};

// A plain function component: the visitor renderer rejects memo and
// forwardRef wrappers. `edit.field('body')` on the root makes the text
// editable on the page itself. RichText adds no wrapper of its own, so the
// root element below is the only element around the paragraphs.
const Text: BlockComponent<TextProps> = ({ props, edit }) => (
  <div {...edit} {...edit.field('body')} className="space-y-4">
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
    },
  },
  component: Text,
});
