import { defineBlock } from '@plakboek/core';
import type { BlockComponent } from '@plakboek/render';

type HeadingProps = {
  text: string;
  level?: string;
};

// A plain function component: the visitor renderer rejects memo and
// forwardRef wrappers. `edit.field('text')` adds nothing on a visitor page
// and lets the page editor make the text editable later.
const Heading: BlockComponent<HeadingProps> = ({ props, edit }) => {
  const level = props.level ?? '2';
  if (level === '1') {
    return (
      <h1 className="text-3xl font-semibold" {...edit.field('text')}>
        {props.text}
      </h1>
    );
  }
  if (level === '3') {
    return (
      <h3 className="text-sm font-semibold" {...edit.field('text')}>
        {props.text}
      </h3>
    );
  }
  return (
    <h2 className="text-xl font-semibold" {...edit.field('text')}>
      {props.text}
    </h2>
  );
};

export const heading = defineBlock({
  key: 'heading',
  editor: { label: 'Heading' },
  schemaVersion: 1,
  properties: {
    text: {
      fieldType: 'short_text',
      label: 'Text',
      required: true,
      options: { maxLength: 200 },
    },
    level: {
      fieldType: 'select',
      label: 'Level',
      defaultValue: '2',
      options: {
        choices: [
          { value: '1', labels: { en: 'Heading 1', nl: 'Kop 1' } },
          { value: '2', labels: { en: 'Heading 2', nl: 'Kop 2' } },
          { value: '3', labels: { en: 'Heading 3', nl: 'Kop 3' } },
        ],
      },
    },
  },
  component: Heading,
});
