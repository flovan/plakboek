/**
 * Who is asking, decided on the server from the session and nothing else.
 *
 * Every shell and frame request calls this. The session cookie is the only
 * input a client controls, and it is verified by the auth package against the
 * stored session; the role, the two-factor flag, the name and the email come
 * from the user row that session resolves to. The `plakboek:editor` browser
 * flag, a query value or any header a client can set grants nothing here.
 */
import type { Auth } from '@plakboek/auth';
import type { PermissionResolver } from '@plakboek/permissions';

export type EditorIdentity = {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly roleKey: string;
  readonly twoFactorEnabled: boolean;
  /** May edit pages: the frame carries live attributes. */
  readonly canEdit: boolean;
  /** May read unpublished work: the frame shows the working tree. */
  readonly canReadDrafts: boolean;
};

/**
 * The editor identity for a request, or `null` without a valid session.
 *
 * The cookie cache is bypassed so a revoked session or a changed role takes
 * effect on the very next request. An impersonation session resolves to the
 * impersonated user's row, so it is treated as that user.
 */
export async function readEditorIdentity(
  auth: Pick<Auth, 'api'>,
  resolver: PermissionResolver,
  request: Request,
): Promise<EditorIdentity | null> {
  const found = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (found === null) return null;

  const { user } = found;
  // The admin plugin's role and the two-factor flag are schema additions the
  // inferred user type does not always carry.
  const role: unknown = Reflect.get(user, 'role');
  const twoFactor: unknown = Reflect.get(user, 'twoFactorEnabled');
  const roleKey = typeof role === 'string' ? role : '';
  const permissions = resolver.resolve(roleKey, { userId: user.id });
  return {
    userId: user.id,
    name: typeof user.name === 'string' ? user.name : '',
    email: typeof user.email === 'string' ? user.email : '',
    roleKey,
    twoFactorEnabled: twoFactor === true,
    canEdit: permissions.has('pages:edit'),
    canReadDrafts: permissions.has('pages:read-drafts'),
  };
}
