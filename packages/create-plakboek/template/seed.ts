import type { SeedPage } from '@plakboek/core';

// The home page every new installation starts with. `plakboek bootstrap` and
// the setup page publish it at /. Change it freely: it only runs on an empty
// installation.
export const seed: SeedPage = {
  title: 'Home',
  blocks: [
    {
      type: 'section',
      props: { width: 'contained', spacing: 'lg' },
      children: [
        {
          type: 'heading',
          props: { text: 'Hello world', level: '1' },
        },
      ],
    },
  ],
};
