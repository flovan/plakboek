/**
 * The render package's warning hooks (01 D-15). A hook is the host's seam for
 * logging and alerting; a broken hook never crashes a request, because every
 * call goes through `reportPagesWarning`, which contains a throw or a
 * rejected promise.
 */
import { reportPagesWarning } from '@plakboek/pages';

/** A snapshot block whose type has no definition in the host config. */
export type UnknownBlockEvent = {
  readonly blockType: string;
  readonly blockId: string;
  readonly pageId: string;
};

/** A declared block type that has no usable component. */
export type MissingComponentEvent = {
  readonly blockType: string;
};

/** A block component threw while rendering. */
export type BlockRenderErrorEvent = {
  readonly blockType: string;
  readonly blockId: string;
  readonly pageId: string;
  readonly error: unknown;
};

/** The render or database path of a request threw. */
export type RenderErrorEvent = {
  readonly publicPath: string;
  readonly pageId: string | null;
  readonly error: unknown;
};

/** A cache backend operation threw; the request continued uncached. */
export type CacheErrorEvent = {
  readonly operation: 'ticket' | 'get' | 'set';
  readonly key: string;
  readonly error: unknown;
};

export type RenderHooks = {
  readonly onUnknownBlock?: (event: UnknownBlockEvent) => void;
  readonly onMissingComponent?: (event: MissingComponentEvent) => void;
  readonly onBlockRenderError?: (event: BlockRenderErrorEvent) => void;
  readonly onRenderError?: (event: RenderErrorEvent) => void;
  readonly onCacheError?: (event: CacheErrorEvent) => void;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The fallback line carries ids and error names only: an error message can
 * quote query parameters or stored content. */
function redact(event: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).map(([key, value]) => [
      key,
      key === 'error' ? errorName(value) : value,
    ]),
  );
}

/** Invokes one of the host's hooks, or logs a redacted line when it set none. */
export function reportRenderEvent<E extends object>(
  name: keyof RenderHooks,
  hook: ((event: E) => void) | undefined,
  event: E,
): void {
  reportPagesWarning(
    hook,
    (fallbackEvent: E) => {
      // oxlint-disable-next-line no-console -- default fallback when the host supplies no render hook; carries ids and error names only
      console.error(`[@plakboek/render] ${name}`, redact(fallbackEvent));
    },
    event,
  );
}
