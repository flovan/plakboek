import { ISLAND_ELEMENT_ID, type ShellIsland } from '../chrome/island.js';

/** Where the island is read from: anything with `getElementById`, so tests
 * need no DOM. A `Document` satisfies it. */
export type IslandSource = {
  getElementById(id: string): { readonly textContent: string | null } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A strictly shaped shell island, or `null` for anything else. */
function toShellIsland(value: Record<string, unknown>): ShellIsland | null {
  const { mode, user, visitorLocation, frameUrl, logoutPath } = value;
  if (mode !== 'edit' && mode !== 'read-only') return null;
  if (!isRecord(user)) return null;
  const name = text(user.name);
  const email = text(user.email);
  const location = text(visitorLocation);
  const frame = text(frameUrl);
  const logout = text(logoutPath);
  if (
    name === null ||
    email === null ||
    location === null ||
    frame === null ||
    logout === null
  ) {
    return null;
  }
  return {
    kind: 'shell',
    mode,
    user: { name, email },
    visitorLocation: location,
    frameUrl: frame,
    logoutPath: logout,
  };
}

/**
 * Reads and validates the JSON island the server wrote. Returns `null` when
 * the element is missing, is not valid JSON, or does not have the exact shape
 * of a known island kind, so a damaged or foreign island boots nothing.
 */
export function readIsland(source: IslandSource): ShellIsland | null {
  const content = source.getElementById(ISLAND_ELEMENT_ID)?.textContent;
  if (content === null || content === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return parsed.kind === 'shell' ? toShellIsland(parsed) : null;
}
