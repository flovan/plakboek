/**
 * The shapes the editor API accepts. A body or a route parameter is parsed
 * here before anything reads it; a failure names the offending keys and zod's
 * issue codes, never a value.
 */
import { z } from 'zod';
import type { ApiIssue } from '../../api-types.js';
import { ApiHttpError } from './http.js';

/** The longest address the API reads, matching the visitor path bound. */
const MAX_PATH_LENGTH = 2048;

/** `/cms/api/open`: the visitor path of the page to edit. Only a site-relative
 * path is accepted: it starts with one slash and carries no backslash. */
export const openBody = z.object({
  path: z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .refine(
      (path) =>
        path.startsWith('/') && !path.startsWith('//') && !path.includes('\\'),
      { message: 'path' },
    ),
});

/** The lock endpoints take no input but are still JSON. */
export const emptyBody = z.object({});

/** A page id in a route. */
export const pageIdParam = z.uuid();

function issuesOf(error: z.ZodError): readonly ApiIssue[] {
  return error.issues.map((issue) => ({
    key: issue.path.length === 0 ? 'body' : issue.path.map(String).join('.'),
    code: issue.code,
  }));
}

/** The parsed value, or an `ApiHttpError` 400 naming keys and codes. */
export function parseWith<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiHttpError(400, 'invalid-request', issuesOf(result.error));
  }
  return result.data;
}
