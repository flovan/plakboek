import { describe, expect, it } from 'vitest';
import { applyPatchSteps } from '../../src/client/frame/patch.js';
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { fakeFrameDocument } from './support/frame-document.js';

const html = (id: string): string =>
  `<section ${EDIT_ATTRIBUTE.block}="${id}"></section>`;

describe('applyPatchSteps', () => {
  it('reports a new top-level section as created, not as replaced', () => {
    const frame = fakeFrameDocument(['s1']);
    const result = applyPatchSteps(frame.document, [
      { kind: 'create-root', id: 's2', html: html('s2') },
    ]);
    expect(result).toEqual({
      replaced: [],
      created: ['s2'],
      reloadNeeded: false,
    });
    expect(frame.ids()).toEqual(['s1', 's2']);
  });

  it('asks for a reload when there is no section to put the new one after', () => {
    const frame = fakeFrameDocument([]);
    const result = applyPatchSteps(frame.document, [
      { kind: 'create-root', id: 's2', html: html('s2') },
    ]);
    expect(result.reloadNeeded).toBe(true);
    expect(result.created).toEqual([]);
  });
});
