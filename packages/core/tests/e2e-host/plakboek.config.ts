import { defaultRoles, defineConfig } from '@plakboek/core/config';
import {
  accordion,
  accordionItem,
  accordionList,
  badge,
  carousel,
  heading,
  propsDemo,
  quote,
  section,
  siteForm,
  slide,
  slides,
  spacer,
  tab,
  tabs,
  text,
} from './blocks.tsx';

export default defineConfig({
  siteName: 'Adversarial fixture',
  locales: ['en'],
  defaultLocale: 'en',
  timezone: 'Europe/Brussels',
  roles: {
    ...defaultRoles,
    viewer: ['pages:read'],
    // Edits pages but may not delete: Delete and the undo of an insert or copy are off.
    'editor-no-delete': ['pages:read', 'pages:read-drafts', 'pages:edit'],
  },
  blocks: [
    section,
    heading,
    text,
    accordion,
    carousel,
    badge,
    spacer,
    siteForm,
    propsDemo,
    quote,
    accordionList,
    accordionItem,
    tabs,
    tab,
    slides,
    slide,
  ],
  // The constraints the Properties panel has to honour: one property is not
  // shown, one has a fixed value, one offers only two of its three choices.
  // Written as plain sets because this host imports only the core package.
  constraints: [
    {
      blockKey: 'propsDemo',
      properties: {
        hiddenProp: 'hidden',
        fixedProp: { fixed: 'fixed value' },
        narrowedProp: { allow: ['alpha', 'beta'] },
      },
    },
  ],
  seed: {
    title: 'Home',
    blocks: [
      {
        type: 'section',
        props: { variant: 'plain' },
        children: [
          { type: 'heading', props: { text: 'Plain section' } },
          {
            type: 'text',
            props: { text: 'A section with no containing-block tricks.' },
          },
          {
            type: 'accordion',
            props: { title: 'First accordion', body: 'First panel body' },
          },
        ],
      },
      {
        type: 'section',
        props: { variant: 'transform' },
        children: [
          { type: 'heading', props: { text: 'Transform section' } },
          { type: 'text', props: { text: 'A section under a transform.' } },
          { type: 'carousel', props: { label: 'Slides' } },
          { type: 'badge', props: { label: 'Always on top' } },
        ],
      },
      {
        type: 'section',
        props: { variant: 'filter' },
        children: [
          { type: 'heading', props: { text: 'Filter section' } },
          { type: 'text', props: { text: 'A section under a filter.' } },
          {
            type: 'accordion',
            props: { title: 'Second accordion', body: 'Second panel body' },
          },
        ],
      },
      {
        type: 'section',
        props: { variant: 'contain' },
        children: [
          { type: 'heading', props: { text: 'Contain section' } },
          {
            type: 'text',
            props: { text: 'A section with layout and paint containment.' },
          },
        ],
      },
      {
        type: 'section',
        props: { variant: 'isolation' },
        children: [
          { type: 'heading', props: { text: 'Isolation section' } },
          {
            type: 'text',
            props: { text: 'A section that isolates its stacking context.' },
          },
          { type: 'spacer', props: { size: 'tall' } },
        ],
      },
    ],
  },
});
