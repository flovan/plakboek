#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './run.js';
import { spawnProcess } from './spawn.js';

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

// CREATE_PLAKBOEK_TEMPLATE_DIR is an internal seam for the CLI's own tests;
// it is not a supported setting and is not documented for users.
const templateDir =
  process.env.CREATE_PLAKBOEK_TEMPLATE_DIR ??
  fileURLToPath(new URL('../template/', import.meta.url));

process.exitCode = await run({
  argv: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
  nodeVersion: process.versions.node,
  spawn: spawnProcess,
  templateDir,
  version: manifest.version,
});
