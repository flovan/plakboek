import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewRequest, PreviewResponse } from '../../src/api-types.js';
import type { ApiClient } from '../../src/client/session/api-client.js';
import { createPreviewRunner } from '../../src/client/session/preview-runner.js';

type Call = {
  readonly request: PreviewRequest;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (response: PreviewResponse) => void;
};

function setup() {
  const calls: Call[] = [];
  const api = {
    preview: (_pageId: string, request: PreviewRequest, signal?: AbortSignal) =>
      new Promise<PreviewResponse>((resolve) => {
        calls.push({ request, signal, resolve });
      }),
  } satisfies Pick<ApiClient, 'preview'>;
  // No frame: the answers are handed back and nothing is patched here.
  const runner = createPreviewRunner({
    api,
    pageId: 'p1',
    frame: () => null,
    hooks: () => null,
  });
  return { runner, calls };
}

const OK: PreviewResponse = { ok: true, html: '<h2></h2>', needsInput: [] };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the preview runner', () => {
  it('waits for 150ms of quiet before a text-like change is rendered', async () => {
    const { runner, calls } = setup();
    const answer = runner.change('b1', { props: { text: 'a' } }, false);
    await vi.advanceTimersByTimeAsync(149);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual({ blockId: 'b1', props: { text: 'a' } });
    calls[0]?.resolve(OK);
    expect(await answer).toEqual(OK);
  });

  it('renders a picker, switch, select or slider change at once', async () => {
    const { runner, calls } = setup();
    void runner.change('b1', { props: { on: true } }, true);
    expect(calls).toHaveLength(1);
  });

  it('restarts the wait on each keystroke and renders only the last text', async () => {
    const { runner, calls } = setup();
    const first = runner.change('b1', { props: { text: 'a' } }, false);
    await vi.advanceTimersByTimeAsync(100);
    const second = runner.change('b1', { props: { text: 'ab' } }, false);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.props).toEqual({ text: 'ab' });
    // the superseded change never ran and settles with nothing
    expect(await first).toBeNull();
    calls[0]?.resolve(OK);
    expect(await second).toEqual(OK);
  });

  it('aborts a request a newer change supersedes, and ignores its late answer', async () => {
    const { runner, calls } = setup();
    const older = runner.change('b1', { props: { size: 'a' } }, true);
    const newer = runner.change('b1', { props: { size: 'b' } }, true);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls[1]?.signal?.aborted).toBe(false);

    // the older answer arrives last and must not win
    calls[1]?.resolve(OK);
    calls[0]?.resolve({ ok: false, issues: [{ key: 'size', code: 'X' }] });
    expect(await newer).toEqual(OK);
    expect(await older).toBeNull();
  });

  it('keeps blocks apart: a change to one does not supersede another', async () => {
    const { runner, calls } = setup();
    void runner.change('b1', { props: {} }, true);
    void runner.change('b2', { props: {} }, true);
    expect(calls.map((call) => call.signal?.aborted)).toEqual([false, false]);
  });

  it('hands the engine refusal back as it came, issues and all', async () => {
    const { runner, calls } = setup();
    const answer = runner.change('b1', { props: { n: 9 } }, true);
    calls[0]?.resolve({ ok: false, issues: [{ key: 'n', code: 'TOO_BIG' }] });
    expect(await answer).toEqual({
      ok: false,
      issues: [{ key: 'n', code: 'TOO_BIG' }],
    });
  });

  it('cancels what is waiting and what is in flight', async () => {
    const { runner, calls } = setup();
    const waiting = runner.change('b1', { props: {} }, false);
    runner.cancel('b1');
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(0);
    expect(await waiting).toBeNull();

    const running = runner.change('b1', { props: {} }, true);
    runner.cancel();
    expect(calls[0]?.signal?.aborted).toBe(true);
    calls[0]?.resolve(OK);
    expect(await running).toBeNull();
  });
});
