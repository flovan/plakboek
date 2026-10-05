import { defineConfig } from '@plakboek/core/config';
import { heading, section } from './blocks.tsx';

export default defineConfig({
  siteName: 'Fixture site',
  locales: ['en', 'nl'],
  defaultLocale: 'en',
  timezone: 'Europe/Brussels',
  blocks: [section, heading],
  menus: { main: [{ label: 'Home', href: '/' }] },
  seed: {
    title: 'Home',
    blocks: [
      {
        type: 'section',
        children: [{ type: 'heading', props: { text: 'Hello world' } }],
      },
    ],
  },
});
