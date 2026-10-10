import {
  ISLAND_ELEMENT_ID,
  type LinkKind,
  type LoginIsland,
  type LoginStep,
  type ShellIsland,
} from '../chrome/island.js';

/** Every island the client can be handed. */
export type EditorIsland = ShellIsland | LoginIsland;

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

const LOGIN_STEPS: readonly LoginStep[] = [
  'sign-in',
  'set-password',
  'reset-password',
  'magic-landing',
  'invalid-link',
  'enrol',
];

const LINK_KINDS: readonly LinkKind[] = ['invite', 'reset', 'sign-in'];

function loginStepOf(value: unknown): LoginStep | null {
  return LOGIN_STEPS.find((step) => step === value) ?? null;
}

function linkKindOf(value: unknown): LinkKind | null {
  return LINK_KINDS.find((kind) => kind === value) ?? null;
}

/** A list of text values, or `null` when it is anything else. */
function textList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') return null;
    items.push(item);
  }
  return items;
}

/** A strictly shaped login island, or `null` for anything else. */
function toLoginIsland(value: Record<string, unknown>): LoginIsland | null {
  const step = loginStepOf(value.step);
  const next = text(value.next);
  const roles = textList(value.twoFactorRequiredRoles);
  if (step === null || next === null || roles === null) return null;
  const linkKind =
    value.linkKind === undefined ? undefined : linkKindOf(value.linkKind);
  if (linkKind === null) return null;
  const email = value.email === undefined ? undefined : text(value.email);
  if (email === null) return null;
  return {
    kind: 'login',
    step,
    next,
    twoFactorRequiredRoles: roles,
    ...(linkKind === undefined ? {} : { linkKind }),
    ...(email === undefined ? {} : { email }),
  };
}

/**
 * Reads and validates the JSON island the server wrote. Returns `null` when
 * the element is missing, is not valid JSON, or does not have the exact shape
 * of a known island kind, so a damaged or foreign island boots nothing.
 */
export function readIsland(source: IslandSource): EditorIsland | null {
  const content = source.getElementById(ISLAND_ELEMENT_ID)?.textContent;
  if (content === null || content === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.kind === 'shell') return toShellIsland(parsed);
  if (parsed.kind === 'login') return toLoginIsland(parsed);
  return null;
}
