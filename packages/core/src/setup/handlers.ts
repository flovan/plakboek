/**
 * The request handlers behind the first-run routes (D-08, D-09, D-11). They
 * take a `Request` and the runtime and return a `Response`, so the route
 * modules stay one line each and tests drive them without a server.
 *
 * Setup exists only while the installation has zero users (D-08). It is
 * deliberately open to anyone who can reach it (D-09); the race between two
 * submitters is closed by the first-user lock inside `bootstrapInstallation`,
 * and the window closes with the first user.
 */
import {
  DatabaseNotReadyError,
  InstallationNotEmptyError,
  bootstrapInstallation,
  validateBootstrapInput,
  type BootstrapField,
} from '../runtime/bootstrap.js';
import { isDatabaseNotReady } from '../runtime/db.js';
import type { Runtime } from '../runtime/runtime.js';
import {
  renderSetupComplete,
  renderSetupForm,
  renderSetupUnavailable,
} from './render.js';
import { SETUP_CSP } from './styles.js';
import { createTestEmailToken } from './token.js';

/** Headers on every setup response: uncacheable, unindexable, locked down. */
export function setupHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': SETUP_CSP,
  };
}

export function setupResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: setupHeaders() });
}

function forbidden(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/**
 * Cross-origin form posts are refused (T-06-38). An `Origin` header, when the
 * browser sends one, must match the installation's public origin or the
 * request's own. `PLAKBOEK_URL` is authoritative: behind a TLS-terminating
 * proxy the request URL says `http`, so it alone would reject the real page.
 */
export function isSameOrigin(request: Request, runtime: Runtime): boolean {
  const origin = request.headers.get('Origin');
  if (origin === null) return true;
  const allowed = new Set<string>([new URL(runtime.env.siteUrl).origin]);
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    // An unparseable request URL contributes no origin.
  }
  return allowed.has(origin);
}

async function hasUsers(runtime: Runtime): Promise<boolean> {
  const [row] = await runtime.db.sql<
    { populated: boolean }[]
  >`SELECT EXISTS (SELECT 1 FROM "user") AS populated`;
  return row?.populated === true;
}

/** Form fields as strings; a missing or non-text value is an empty string. */
export async function readFormFields(
  request: Request,
  names: readonly string[],
): Promise<Record<string, string>> {
  let form: FormData | undefined;
  try {
    form = await request.formData();
  } catch {
    form = undefined;
  }
  const fields: Record<string, string> = {};
  for (const name of names) {
    const value = form?.get(name);
    fields[name] = typeof value === 'string' ? value : '';
  }
  return fields;
}

const SETUP_FIELDS = ['name', 'email', 'password', 'passwordConfirm'] as const;

export async function handleSetupGet(
  request: Request,
  runtime: Runtime,
): Promise<Response> {
  try {
    if (await hasUsers(runtime)) return await runtime.notFoundResponse(request);
    return setupResponse(renderSetupForm(), 200);
  } catch (error) {
    if (isDatabaseNotReady(error)) {
      return setupResponse(renderSetupUnavailable('database'), 503);
    }
    throw error;
  }
}

export async function handleSetupPost(
  request: Request,
  runtime: Runtime,
): Promise<Response> {
  if (!isSameOrigin(request, runtime)) return forbidden();

  try {
    if (await hasUsers(runtime)) {
      return setupResponse(renderSetupUnavailable('race'), 409);
    }

    const fields = await readFormFields(request, SETUP_FIELDS);
    const input = {
      name: fields.name ?? '',
      email: fields.email ?? '',
      password: fields.password ?? '',
      passwordConfirm: fields.passwordConfirm ?? '',
    };

    const issues = validateBootstrapInput(input);
    if (issues.length > 0) return unprocessable(input, issues);

    const result = await bootstrapInstallation(runtime, input);
    const token = createTestEmailToken({
      secret: runtime.env.secret,
      userId: result.userId,
      homePublished: result.homePublished,
    });
    return setupResponse(
      renderSetupComplete({
        email: result.email,
        token,
        homePublished: result.homePublished,
      }),
      200,
    );
  } catch (error) {
    if (error instanceof InstallationNotEmptyError) {
      return setupResponse(renderSetupUnavailable('race'), 409);
    }
    if (error instanceof DatabaseNotReadyError || isDatabaseNotReady(error)) {
      return setupResponse(renderSetupUnavailable('database'), 503);
    }
    // Anything else is a bug: React Router's production error response
    // carries no detail, and nothing here is logged with a password in it.
    throw error;
  }
}

function unprocessable(
  values: { readonly name: string; readonly email: string },
  issues: readonly { field: BootstrapField; message: string }[],
): Response {
  return setupResponse(
    renderSetupForm({
      values: { name: values.name, email: values.email },
      issues,
    }),
    422,
  );
}
