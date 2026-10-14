/**
 * Live preview of a property change (D-24). A change asks the preview route to
 * render the block with the candidate values and, when the engine accepts
 * them, swaps the block's markup in the frame in one replace step. Text-like
 * changes wait for 150ms of quiet; pickers, switches, selects and sliders go
 * at once. Each block has one request in flight: a newer change aborts the
 * older one, and an answer that is no longer the latest is ignored, so the
 * last change always wins.
 *
 * Only the edited block's markup is replaced, through the same patch planner
 * and applier a saved write uses, so other blocks, the frame's scroll and the
 * panel's own focus and caret are left alone. A refusal is not an error: the
 * issues are handed back and the frame stays on its last render.
 */
import type { ModelLayout, PreviewResponse } from '../../api-types.js';
import { applyPatchSteps, domViewOf } from '../frame/patch.js';
import { planPatch } from '../frame/patch-plan.js';
import type { HooksRuntime } from '../frame/hooks-runtime.js';
import type { ApiClient } from './api-client.js';

/** How long a text-like change waits for more typing before it is rendered. */
export const PREVIEW_DEBOUNCE_MS = 150;

export type PreviewRunnerOptions = {
  readonly api: Pick<ApiClient, 'preview'>;
  readonly pageId: string;
  readonly frame: () => HTMLIFrameElement | null;
  readonly hooks: () => HooksRuntime | null;
  readonly debounceMs?: number;
};

/** The whole candidate values of a block: the server replaces props as a whole. */
export type PreviewValues = {
  readonly props?: Readonly<Record<string, unknown>>;
  readonly layout?: ModelLayout | null;
};

export type PreviewRunner = {
  /**
   * Renders the block with `values` in the frame. Resolves with the engine's
   * answer, or `null` when a newer change superseded this one, it was
   * cancelled or the request failed.
   */
  readonly change: (
    blockId: string,
    values: PreviewValues,
    immediate: boolean,
  ) => Promise<PreviewResponse | null>;
  /** Drops everything pending and in flight for a block, or for every block. */
  readonly cancel: (blockId?: string) => void;
};

type Pending = {
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
  /** Settles the promise of a change that will not run. */
  drop: (() => void) | null;
  latest: number;
};

export function createPreviewRunner(
  options: PreviewRunnerOptions,
): PreviewRunner {
  const { api, pageId, frame, hooks } = options;
  const debounceMs = options.debounceMs ?? PREVIEW_DEBOUNCE_MS;
  const blocks = new Map<string, Pending>();

  function pendingFor(blockId: string): Pending {
    let pending = blocks.get(blockId);
    if (pending === undefined) {
      pending = { timer: null, controller: null, drop: null, latest: 0 };
      blocks.set(blockId, pending);
    }
    return pending;
  }

  function supersede(pending: Pending): void {
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    pending.controller?.abort();
    pending.controller = null;
    pending.drop?.();
    pending.drop = null;
  }

  /** Replaces the block's markup in the frame; a block the frame does not show is left alone. */
  function apply(blockId: string, html: string): void {
    const doc = frame()?.contentDocument ?? null;
    if (doc === null) return;
    const plan = planPatch(
      { fragments: [{ id: blockId, html }], removed: [], rootOrder: null },
      domViewOf(doc),
    );
    // A block that is not in the frame, or is being edited in place, is not previewed.
    if (plan.steps.some((step) => step.kind !== 'replace')) return;
    const result = applyPatchSteps(doc, plan.steps);
    if (result.replaced.length > 0) hooks()?.rendered(result.replaced);
  }

  async function run(
    blockId: string,
    values: PreviewValues,
    pending: Pending,
    ticket: number,
  ): Promise<PreviewResponse | null> {
    const controller = new AbortController();
    pending.controller = controller;
    try {
      const response = await api.preview(
        pageId,
        { blockId, ...values },
        controller.signal,
      );
      if (controller.signal.aborted || pending.latest !== ticket) return null;
      if (response.ok) apply(blockId, response.html);
      return response;
    } catch {
      // An aborted request or one that got no answer leaves the frame as it is.
      return null;
    } finally {
      if (pending.controller === controller) pending.controller = null;
    }
  }

  return {
    change: (blockId, values, immediate) => {
      const pending = pendingFor(blockId);
      supersede(pending);
      pending.latest += 1;
      const ticket = pending.latest;
      if (immediate) return run(blockId, values, pending, ticket);
      return new Promise<PreviewResponse | null>((resolve) => {
        pending.drop = () => {
          resolve(null);
        };
        pending.timer = setTimeout(() => {
          pending.timer = null;
          pending.drop = null;
          void run(blockId, values, pending, ticket).then(resolve);
        }, debounceMs);
      });
    },
    cancel: (blockId) => {
      if (blockId !== undefined) {
        const pending = blocks.get(blockId);
        if (pending !== undefined) supersede(pending);
        return;
      }
      for (const pending of blocks.values()) supersede(pending);
    },
  };
}
