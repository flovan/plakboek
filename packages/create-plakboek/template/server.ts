import { createServer } from '@plakboek/core/server';

// Serves the build in ./build: static assets first, then every page.
await createServer().start();
