import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import * as root from '@plakboek/core';
import { defineBlock, defineModule } from '@plakboek/core';
import { PlakboekConfigError, defineConfig } from '@plakboek/core/config';
import { cmsRoutes } from '@plakboek/core/routes';
import { createServer } from '@plakboek/core/server';
import { plakboek } from '@plakboek/core/vite';

// Runs against the packed tarball in a non-workspace consumer: every entry
// resolves through the published exports map, and the bin is the one npm
// linked, run directly so its shebang and executable bit are exercised too.
const failures: string[] = [];

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

// The root entry is the client-safe block-authoring surface and nothing else.
expectEqual(
  'root entry values',
  Object.keys(root).toSorted().join(','),
  'defineBlock,defineModule',
);

const block = {
  key: 'probe',
  editor: { label: 'Probe' },
  schemaVersion: 1,
  properties: {},
  component: () => null,
};
expectEqual('defineBlock is an identity', defineBlock(block), block);

const module = { name: 'probe-module' };
expectEqual('defineModule is an identity', defineModule(module), module);

// A bad site name is rejected before any engine runs, so a minimal rest is
// enough to reach the check.
let thrown: unknown;
try {
  defineConfig({
    siteName: '',
    locales: ['en'],
    defaultLocale: 'en',
    timezone: 'Europe/Brussels',
    blocks: [],
  });
} catch (error) {
  thrown = error;
}
expectEqual(
  'defineConfig rejects a blank site name',
  thrown instanceof Error ? thrown.name : String(thrown),
  'PlakboekConfigError',
);
expectEqual(
  'the thrown error is the exported class',
  thrown instanceof PlakboekConfigError,
  true,
);

const routes = cmsRoutes();
expectEqual(
  'cmsRoutes ids',
  routes.map((entry) => entry.id).join(','),
  [
    'plakboek-health',
    'plakboek-setup',
    'plakboek-setup-test-email',
    'plakboek-auth',
    'plakboek-visitor-index',
    'plakboek-visitor',
  ].join(','),
);
for (const entry of routes) {
  expectEqual(
    `${entry.id ?? 'route'} file is absolute`,
    isAbsolute(entry.file),
    true,
  );
  expectEqual(
    `${entry.id ?? 'route'} file exists`,
    existsSync(entry.file),
    true,
  );
}

expectEqual('plakboek() is a function', typeof plakboek, 'function');
expectEqual(
  'plakboek() builds a named plugin',
  plakboek({ config: './c.ts', site: './s.ts' }).name,
  'plakboek',
);
expectEqual('createServer is a function', typeof createServer, 'function');

const consumerDir = import.meta.dirname;
const packed = JSON.parse(
  readFileSync(
    join(consumerDir, 'node_modules', '@plakboek', 'core', 'package.json'),
    'utf8',
  ),
) as { version: string };
const bin = join(consumerDir, 'node_modules', '.bin', 'plakboek');
expectEqual(
  'the plakboek bin prints the packed version',
  execFileSync(bin, ['--version'], { encoding: 'utf8' }),
  `${packed.version}\n`,
);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(
  `core.ts: the packed package resolves, validates, routes and runs its bin (${packed.version})`,
);
