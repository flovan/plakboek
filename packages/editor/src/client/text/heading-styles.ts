import type { HeadingLevel } from '@plakboek/content/rich-text';

/** The heading styles of the Text style menu and the '/' menu. */
export type HeadingStyleId = 'title' | 'heading' | 'subheading';

/** The heading level each style stands for: the page's own title owns h1. */
export const STYLE_LEVEL: Readonly<Record<HeadingStyleId, HeadingLevel>> = {
  title: 2,
  heading: 3,
  subheading: 4,
};
