import { defineBlock } from '@plakboek/core';
import type { BlockComponent } from '@plakboek/render';

type SectionProps = {
  width?: string;
  spacing?: string;
};

const WIDTH: Record<string, string> = {
  contained: 'max-w-[1120px] mx-auto px-6',
  full: 'w-full',
};

const SPACING: Record<string, string> = {
  none: 'py-0',
  md: 'py-8',
  lg: 'py-16',
};

// A plain function component: the visitor renderer rejects memo and
// forwardRef wrappers. Spreading `edit` adds nothing on a visitor page and
// lets the page editor bind to this block later.
const Section: BlockComponent<SectionProps> = ({ props, children, edit }) => (
  <section {...edit}>
    <div
      className={`${WIDTH[props.width ?? 'contained'] ?? WIDTH.contained} ${
        SPACING[props.spacing ?? 'lg'] ?? SPACING.lg
      }`}
    >
      {children}
    </div>
  </section>
);

// A layout-only block: it holds other blocks and has no content of its own.
export const section = defineBlock({
  key: 'section',
  kind: 'section',
  editor: { label: 'Section' },
  schemaVersion: 1,
  properties: {
    width: {
      fieldType: 'select',
      label: 'Width',
      defaultValue: 'contained',
      options: {
        choices: [
          {
            value: 'contained',
            labels: { en: 'Contained', nl: 'Binnen kader' },
          },
          {
            value: 'full',
            labels: { en: 'Full width', nl: 'Volledige breedte' },
          },
        ],
      },
    },
    spacing: {
      fieldType: 'select',
      label: 'Spacing',
      defaultValue: 'lg',
      options: {
        choices: [
          { value: 'none', labels: { en: 'None', nl: 'Geen' } },
          { value: 'md', labels: { en: 'Medium', nl: 'Gemiddeld' } },
          { value: 'lg', labels: { en: 'Large', nl: 'Groot' } },
        ],
      },
    },
  },
  component: Section,
});
