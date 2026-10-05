import type { Config } from '@react-router/dev/config';

export default {
  ssr: true,
  // The variant build in the integration suite writes next to the default.
  buildDirectory: process.env.FIXTURE_BUILD_DIR ?? 'build',
} satisfies Config;
