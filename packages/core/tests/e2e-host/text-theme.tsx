import { defineTextTheme } from '@plakboek/render';

/**
 * The e2e host's text theme: a small palette, one size, alignment and two
 * button looks, with every mark and node the default theme allows.
 */
export default defineTextTheme({
  colors: [
    { label: 'Accent', token: 'accent' },
    { label: 'Muted', token: 'text-muted' },
  ],
  sizes: [{ label: 'Large', token: 'xl' }],
  align: true,
  ctaVariants: [
    { label: 'Primary', value: 'primary' },
    { label: 'Secondary', value: 'secondary' },
  ],
});
