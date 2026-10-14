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

/**
 * The item-based interactive blocks. Each container renders only its items;
 * an item is a block of its own (its root spreads `{...edit}`), so the editor
 * adds, moves, selects and drills into entries, tabs and slides like any other
 * block. The site's script (`public/site.js`) drives them.
 */
const AccordionList: BlockComponent<Record<string, never>> = ({
  children,
  edit,
}) => (
  <div {...edit} className="accordion-list" data-accordion-list="">
    {children}
  </div>
);

const AccordionItem: BlockComponent<{ title: string }> = ({
  block,
  props,
  children,
  edit,
}) => (
  <div {...edit} className="accordion-item" data-accordion-item="">
    <button
      type="button"
      aria-expanded="false"
      aria-controls={`entry-${block.id}`}
      data-accordion-trigger=""
      {...edit.field('title')}
    >
      {props.title}
    </button>
    <div id={`entry-${block.id}`} role="region" hidden data-accordion-panel="">
      {children}
    </div>
  </div>
);

const Tabs: BlockComponent<Record<string, never>> = ({ children, edit }) => (
  <div {...edit} className="tabs" data-tabs="" role="tablist">
    {children}
  </div>
);

const Tab: BlockComponent<{ label: string }> = ({
  block,
  props,
  children,
  edit,
}) => (
  <div {...edit} className="tab" data-tab="">
    <button
      type="button"
      role="tab"
      aria-selected="false"
      aria-controls={`tab-${block.id}`}
      data-tab-trigger=""
      {...edit.field('label')}
    >
      {props.label}
    </button>
    <div id={`tab-${block.id}`} role="tabpanel" hidden data-tab-panel="">
      {children}
    </div>
  </div>
);

const Slides: BlockComponent<{ autoplay?: boolean }> = ({
  props,
  children,
  edit,
}) => (
  <div
    {...edit}
    className="slides"
    data-slides=""
    data-autoplay={props.autoplay === true ? 'true' : 'false'}
    role="group"
    aria-label="Slides"
  >
    <div data-slides-track="">{children}</div>
    <button type="button" data-slides-prev="">
      Previous slide
    </button>
    <button type="button" data-slides-next="">
      Next slide
    </button>
  </div>
);

const Slide: BlockComponent<Record<string, never>> = ({ children, edit }) => (
  <div {...edit} className="slide" data-slide="">
    {children}
  </div>
);

const Badge: BlockComponent<{ label: string }> = ({ props, edit }) => (
  <div {...edit} className="badge" data-badge="">
    <span {...edit.field('label')}>{props.label}</span>
  </div>
);

/**
 * A coloured quote that can fill its column: with `layout.fill` on, its root
 * grows to the column's full height, as a block that supports fill does.
 */
const Quote: BlockComponent<{ text: string }> = ({ props, edit, layout }) => (
  <blockquote
    {...edit}
    {...edit.field('text')}
    className="quote"
    style={{
      margin: 0,
      padding: '16px',
      background: '#e0e7ff',
      ...(layout.fill === true ? { flex: '1 1 auto' } : {}),
    }}
  >
    {props.text}
  </blockquote>
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

/**
 * Shows every value it was given as text in an element of its own, so a spec
 * can read what a Properties control changed from the frame.
 */
const PropsDemo: BlockComponent<Record<string, unknown>> = ({
  props,
  edit,
}) => (
  <div {...edit} className="props-demo">
    {Object.entries(props).map(([key, value]) => (
      <p key={key} data-prop={key}>
        {typeof value === 'string' ? value : JSON.stringify(value)}
      </p>
    ))}
  </div>
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

export const quote = defineBlock({
  key: 'quote',
  editor: { label: 'Quote' },
  schemaVersion: 1,
  layout: { fill: true },
  properties: {
    text: {
      fieldType: 'short_text',
      label: 'Text',
      required: true,
      options: { maxLength: 300 },
    },
  },
  component: Quote,
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

const choices = (...values: readonly string[]) =>
  values.map((value) => ({
    value,
    labels: { en: `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` },
  }));

/**
 * One property for every widget the editor draws a control for, and one for
 * each constraint the host config puts on it (hidden, fixed, narrowed).
 */
export const propsDemo = defineBlock({
  key: 'propsDemo',
  editor: { label: 'Props demo' },
  schemaVersion: 1,
  properties: {
    title: {
      fieldType: 'short_text',
      label: 'Title',
      required: true,
      options: { maxLength: 80 },
    },
    link: { fieldType: 'url', label: 'Link', options: {} },
    handle: { fieldType: 'slug', label: 'Handle', options: {} },
    notes: { fieldType: 'long_text', label: 'Notes', options: {} },
    count: {
      fieldType: 'number',
      label: 'Count',
      options: { min: 0, max: 100 },
    },
    level: {
      fieldType: 'integer',
      label: 'Level',
      widget: 'slider',
      options: { min: 0, max: 10 },
    },
    agree: { fieldType: 'boolean', label: 'Agree', options: {} },
    active: {
      fieldType: 'boolean',
      label: 'Active',
      widget: 'switch',
      options: {},
    },
    size: {
      fieldType: 'select',
      label: 'Size',
      options: { choices: choices('small', 'medium', 'large') },
    },
    mood: {
      fieldType: 'select',
      label: 'Mood',
      widget: 'radio',
      options: { choices: choices('calm', 'lively') },
    },
    tags: {
      fieldType: 'multi_select',
      label: 'Tags',
      options: { choices: choices('red', 'green', 'blue') },
    },
    extras: {
      fieldType: 'multi_select',
      label: 'Extras',
      widget: 'multi-dropdown',
      options: { choices: choices('one', 'two', 'three') },
    },
    publishAt: {
      fieldType: 'date_time',
      label: 'Publish at',
      options: { mode: 'instant' },
    },
    day: {
      fieldType: 'date_time',
      label: 'Day',
      widget: 'date-picker',
      options: { mode: 'date' },
    },
    data: { fieldType: 'json', label: 'Data', options: {} },
    items: {
      fieldType: 'repeater',
      label: 'Items',
      options: {
        fields: [
          {
            key: 'label',
            label: 'Item label',
            fieldType: 'short_text',
            options: { maxLength: 30 },
          },
          { key: 'done', label: 'Done', fieldType: 'boolean', options: {} },
        ],
      },
    },
    body: { fieldType: 'rich_text', label: 'Body', options: {} },
    photo: { fieldType: 'image', label: 'Photo', options: {} },
    attachment: { fieldType: 'file', label: 'Attachment', options: {} },
    related: {
      fieldType: 'reference',
      label: 'Related',
      options: { allowedTypeKeys: ['page'], cardinality: 'single' },
    },
    hiddenProp: { fieldType: 'short_text', label: 'Hidden', options: {} },
    fixedProp: { fieldType: 'short_text', label: 'Fixed', options: {} },
    narrowedProp: {
      fieldType: 'select',
      label: 'Narrowed',
      options: { choices: choices('alpha', 'beta', 'gamma') },
    },
  },
  component: PropsDemo,
});

export const accordionList = defineBlock({
  key: 'accordionList',
  editor: { label: 'Accordion list' },
  schemaVersion: 1,
  properties: {},
  placement: { allowedChildren: ['accordionItem'] },
  starterChildren: [
    {
      type: 'accordionItem',
      props: { title: 'First entry' },
      children: [{ type: 'text', props: { text: 'First entry text' } }],
    },
    {
      type: 'accordionItem',
      props: { title: 'Second entry' },
      children: [{ type: 'text', props: { text: 'Second entry text' } }],
    },
  ],
  component: AccordionList,
});

export const accordionItem = defineBlock({
  key: 'accordionItem',
  editor: { label: 'Accordion entry' },
  schemaVersion: 1,
  properties: {
    title: {
      fieldType: 'short_text',
      label: 'Title',
      required: true,
      options: { maxLength: 200 },
    },
  },
  placement: {
    allowedParents: ['accordionList'],
    allowedChildren: ['heading', 'text'],
  },
  component: AccordionItem,
});

export const tabs = defineBlock({
  key: 'tabs',
  editor: { label: 'Tabs' },
  schemaVersion: 1,
  properties: {},
  placement: { allowedChildren: ['tab'] },
  starterChildren: [
    {
      type: 'tab',
      props: { label: 'First tab' },
      children: [{ type: 'text', props: { text: 'First tab text' } }],
    },
    {
      type: 'tab',
      props: { label: 'Second tab' },
      children: [{ type: 'text', props: { text: 'Second tab text' } }],
    },
  ],
  component: Tabs,
});

export const tab = defineBlock({
  key: 'tab',
  editor: { label: 'Tab' },
  schemaVersion: 1,
  properties: {
    label: {
      fieldType: 'short_text',
      label: 'Label',
      required: true,
      options: { maxLength: 100 },
    },
  },
  placement: {
    allowedParents: ['tabs'],
    allowedChildren: ['heading', 'text'],
  },
  component: Tab,
});

export const slides = defineBlock({
  key: 'slides',
  editor: { label: 'Slides' },
  schemaVersion: 1,
  properties: {
    autoplay: { fieldType: 'boolean', label: 'Autoplay', options: {} },
  },
  placement: { allowedChildren: ['slide'] },
  starterChildren: [
    {
      type: 'slide',
      children: [{ type: 'text', props: { text: 'First slide text' } }],
    },
    {
      type: 'slide',
      children: [{ type: 'text', props: { text: 'Second slide text' } }],
    },
  ],
  component: Slides,
});

export const slide = defineBlock({
  key: 'slide',
  editor: { label: 'Slide' },
  schemaVersion: 1,
  properties: {},
  placement: {
    allowedParents: ['slides'],
    allowedChildren: ['heading', 'text'],
  },
  component: Slide,
});
