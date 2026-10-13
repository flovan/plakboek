import { defineBlock } from '@plakboek/core';
import { Columns, type BlockComponent } from '@plakboek/render';

const VARIANTS = ['plain', 'transform', 'filter', 'contain', 'isolation'];

const Section: BlockComponent<{ variant?: string }> = ({
  props,
  children,
  edit,
  layout,
}) => (
  <section {...edit} className={`section variant-${props.variant ?? 'plain'}`}>
    <Columns layout={layout}>{children}</Columns>
  </section>
);

const Heading: BlockComponent<{ text: string }> = ({ props, edit }) => (
  <h2 {...edit} {...edit.field('text')} className="reset-target">
    {props.text}
  </h2>
);

const Text: BlockComponent<{ text: string }> = ({ props, edit }) => (
  <p {...edit} {...edit.field('text')} className="reset-target">
    {props.text}
  </p>
);

const Accordion: BlockComponent<{ title: string; body: string }> = ({
  block,
  props,
  edit,
}) => (
  <div {...edit} className="accordion" data-accordion="">
    <button
      type="button"
      aria-expanded="false"
      aria-controls={`panel-${block.id}`}
      id={`trigger-${block.id}`}
      {...edit.field('title')}
    >
      {props.title}
    </button>
    <div id={`panel-${block.id}`} role="region" hidden {...edit.field('body')}>
      {props.body}
    </div>
  </div>
);

const SLIDES = ['One', 'Two', 'Three'];

const Carousel: BlockComponent<{ label: string }> = ({ props, edit }) => (
  <div
    {...edit}
    className="carousel"
    data-carousel=""
    role="group"
    aria-label={props.label}
  >
    <div className="carousel-viewport">
      <div className="carousel-track" data-carousel-track="" data-index="0">
        {SLIDES.map((slide) => (
          <div className="carousel-slide" key={slide}>
            {slide}
          </div>
        ))}
      </div>
    </div>
    <button type="button" data-carousel-prev="">
      Previous
    </button>
    <button type="button" data-carousel-next="">
      Next
    </button>
  </div>
);

const Badge: BlockComponent<{ label: string }> = ({ props, edit }) => (
  <div {...edit} className="badge" data-badge="">
    <span {...edit.field('label')}>{props.label}</span>
  </div>
);

const SPACER_HEIGHTS: Readonly<Record<string, string>> = {
  tall: '1600px',
  short: '200px',
};

const Spacer: BlockComponent<{ size?: string }> = ({ props, edit }) => (
  <div
    {...edit}
    className="spacer"
    aria-hidden="true"
    style={{ height: SPACER_HEIGHTS[props.size ?? 'tall'] ?? '1600px' }}
  />
);

/** A form that would leave for another page if it were submitted. */
const SiteForm: BlockComponent<{ label: string }> = ({ props, edit }) => (
  <form {...edit} id="site-form" action="/about" method="get">
    <button type="submit" id="site-form-submit">
      {props.label}
    </button>
  </form>
);

export const section = defineBlock({
  key: 'section',
  kind: 'section',
  editor: { label: 'Section' },
  schemaVersion: 1,
  properties: {
    variant: {
      fieldType: 'select',
      label: 'Variant',
      options: {
        choices: VARIANTS.map((value) => ({
          value,
          labels: { en: value },
        })),
      },
    },
  },
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

export const text = defineBlock({
  key: 'text',
  editor: { label: 'Text' },
  schemaVersion: 1,
  properties: {
    text: {
      fieldType: 'short_text',
      label: 'Text',
      required: true,
      options: { maxLength: 500 },
    },
  },
  component: Text,
});

export const accordion = defineBlock({
  key: 'accordion',
  editor: { label: 'Accordion' },
  schemaVersion: 1,
  properties: {
    title: {
      fieldType: 'short_text',
      label: 'Title',
      required: true,
      options: { maxLength: 200 },
    },
    body: {
      fieldType: 'short_text',
      label: 'Body',
      required: true,
      options: { maxLength: 500 },
    },
  },
  component: Accordion,
});

export const carousel = defineBlock({
  key: 'carousel',
  editor: { label: 'Carousel' },
  schemaVersion: 1,
  properties: {
    label: {
      fieldType: 'short_text',
      label: 'Label',
      required: true,
      options: { maxLength: 200 },
    },
  },
  component: Carousel,
});

export const badge = defineBlock({
  key: 'badge',
  editor: { label: 'Badge' },
  schemaVersion: 1,
  properties: {
    label: {
      fieldType: 'short_text',
      label: 'Label',
      required: true,
      options: { maxLength: 200 },
    },
  },
  component: Badge,
});

export const spacer = defineBlock({
  key: 'spacer',
  editor: { label: 'Spacer' },
  schemaVersion: 1,
  properties: {
    size: {
      fieldType: 'select',
      label: 'Size',
      options: {
        choices: [
          { value: 'tall', labels: { en: 'Tall' } },
          { value: 'short', labels: { en: 'Short' } },
        ],
      },
    },
  },
  component: Spacer,
});

export const siteForm = defineBlock({
  key: 'siteForm',
  editor: { label: 'Form' },
  schemaVersion: 1,
  properties: {
    label: {
      fieldType: 'short_text',
      label: 'Label',
      required: true,
      options: { maxLength: 200 },
    },
  },
  component: SiteForm,
});
