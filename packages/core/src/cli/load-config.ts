/**
 * Loads the host's `plakboek.config.ts` into the CLI process.
 *
 * tsx's global `register()` hook teaches this process's own module loader to
 * run TypeScript, and a plain dynamic import then evaluates the file. The
 * config's `defineConfig` therefore fills the very block registry (held in
 * `@plakboek/pages`) that `insertBlock` reads later in this process. tsx's
 * isolated per-call import helper is deliberately not used: it gives the
 * config its own module instances, which would leave the CLI's registry empty.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import type { PlakboekConfig } from '../types.js';

/** The config file is missing or is not a Plakboek config. The message is
 * the exact copy shown to the operator. */
export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostConfigError';
  }
}

function looksLikeConfig(value: unknown): value is PlakboekConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'siteName') === 'string' &&
    typeof Reflect.get(value, 'pages') === 'object' &&
    Reflect.get(value, 'pages') !== null
  );
}

export async function loadHostConfig(path: string): Promise<PlakboekConfig> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new HostConfigError(
      `Could not find ${path}. Run this command from the project root or pass --config <path>.`,
    );
  }

  const unregister = register();
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(absolute).href);
  } finally {
    await unregister();
  }

  const config =
    typeof loaded === 'object' && loaded !== null
      ? Reflect.get(loaded, 'default')
      : undefined;
  if (!looksLikeConfig(config)) {
    throw new HostConfigError(
      `${path} must default-export defineConfig({...}).`,
    );
  }
  return config;
}
