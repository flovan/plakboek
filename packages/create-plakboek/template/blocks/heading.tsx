import { defineBlock } from '@plakboek/core';
import type { BlockComponent } from '@plakboek/render';
import { HEADING_CLASS } from '../text-theme.tsx';

type HeadingProps = {
  text: string;
  level?: string;
};

// A plain function component: the visitor renderer rejects memo and
// forwardRef wrappers. Spreading `edit` on the root lets the page editor
// outline, select and drill into the block, and `edit.field('text')` marks
// its text. Neither adds anything to a visitor page.
//
// There is no level 1: the page's single h1 is placed by the host (the site
// header). The classes are the text theme's, so a heading here and a heading
// typed in a Text block look the same.
const Heading: BlockComponent<HeadingProps> = ({ props, edit }) => {
  const level = props.level ?? '2';
  if (level === '3') {
    return (
      <h3 className={HEADING_CLASS[3]} {...edit} {...edit.field('text')}>
        {props.text}
      </h3>
    );
  }
  if (level === '4') {
    return (
      <h4 className={HEADING_CLASS[4]} {...edit} {...edit.field('text')}>
        {props.text}
      </h4>
    );
  }
  return (
    <h2 className={HEADING_CLASS[2]} {...edit} {...edit.field('text')}>
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
          { value: '2', labels: { en: 'Title', nl: 'Titel' } },
          { value: '3', labels: { en: 'Heading', nl: 'Kop' } },
          { value: '4', labels: { en: 'Subheading', nl: 'Subkop' } },
        ],
      },
    },
  },
  component: Heading,
});
