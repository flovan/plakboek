/**
 * Loads `./.env` from the working directory into `process.env`, never
 * overriding a variable that is already set: the real environment (a deploy
 * platform, CI) always wins over the file. Values are never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export function loadEnvFile(
  directory: string = process.cwd(),
  target: NodeJS.ProcessEnv = process.env,
): void {
  const path = join(directory, '.env');
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined && value !== undefined) target[key] = value;
  }
}
