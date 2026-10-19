import { defineBlock } from '@plakboek/core';
import { CtaButton, type BlockComponent } from '@plakboek/render';
import textTheme from '../text-theme.tsx';

type ButtonProps = {
  label?: string;
  link?: unknown;
  variant?: string;
};

// A plain function component: the visitor renderer rejects memo and
// forwardRef wrappers. CtaButton renders through the theme's `cta` renderer,
// the same one a button typed into a text uses, so the two look identical.
const Button: BlockComponent<ButtonProps> = ({ props, edit }) => (
  <div {...edit} {...edit.field('link')}>
    <CtaButton label={props.label} link={props.link} variant={props.variant} />
  </div>
);

export const button = defineBlock({
  key: 'button',
  editor: { label: 'Button' },
  schemaVersion: 1,
  properties: {
    label: {
      fieldType: 'short_text',
      label: 'Label',
      required: true,
      options: { maxLength: 80 },
    },
    link: {
      fieldType: 'link',
      label: 'Link',
      required: true,
      options: { labelProperty: 'label', variantProperty: 'variant' },
    },
    variant: {
      fieldType: 'select',
      label: 'Style',
      defaultValue: 'primary',
      options: {
        // The styles the text theme lists, so the two stay in step.
        choices: textTheme.theme.ctaVariants.map((entry) => ({
          value: entry.value,
          labels: { en: entry.label },
        })),
      },
    },
  },
  component: Button,
});
