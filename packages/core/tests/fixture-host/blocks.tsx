import { defineBlock } from '@plakboek/core';
import type { BlockComponent } from '@plakboek/render';

const Section: BlockComponent = ({ children }) => <section>{children}</section>;

const Heading: BlockComponent<{ text: string }> = ({ props }) => (
  <h2>{props.text}</h2>
);

export const section = defineBlock({
  key: 'section',
  kind: 'section',
  editor: { label: 'Section' },
  schemaVersion: 1,
  properties: {},
  component: Section,
});

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
  },
  component: Heading,
});
