import { describe, expect, it } from 'vitest';
import {
  isEditableTarget,
  keyAction,
  structureKeyAction,
} from '../../src/client/shell/keys.js';

const plain = { ctrlKey: false, metaKey: false, altKey: false };

describe('keyAction', () => {
  it('toggles the mode on I and climbs on Escape', () => {
    expect(keyAction({ key: 'i', ...plain }, {})).toBe('toggle-mode');
    expect(keyAction({ key: 'I', ...plain }, {})).toBe('toggle-mode');
    expect(keyAction({ key: 'Escape', ...plain }, {})).toBe('climb');
  });

  it('leaves other keys and modified keys alone', () => {
    expect(keyAction({ key: 'a', ...plain }, {})).toBeNull();
    expect(keyAction({ key: 'i', ...plain, ctrlKey: true }, {})).toBeNull();
    expect(
      keyAction({ key: 'Escape', ...plain, metaKey: true }, {}),
    ).toBeNull();
  });

  it('never fires while the user types', () => {
    expect(keyAction({ key: 'i', ...plain }, { tagName: 'INPUT' })).toBeNull();
    expect(
      keyAction({ key: 'i', ...plain }, { tagName: 'textarea' }),
    ).toBeNull();
    expect(
      keyAction({ key: 'Escape', ...plain }, { isContentEditable: true }),
    ).toBeNull();
  });
});

describe('isEditableTarget', () => {
  it('recognises text fields by shape, across documents', () => {
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('structureKeyAction', () => {
  const key = (name: string, extra: Partial<Record<string, boolean>> = {}) => ({
    key: name,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });
  const region = {
    inRegion: true,
    inToolbar: false,
    axis: 'vertical',
  } as const;
  const toolbar = {
    inRegion: false,
    inToolbar: true,
    axis: 'vertical',
  } as const;
  const elsewhere = {
    inRegion: false,
    inToolbar: false,
    axis: 'vertical',
  } as const;

  it('walks, drills and climbs from the region', () => {
    expect(structureKeyAction(key('ArrowDown'), {}, region)).toEqual({
      kind: 'sibling',
      direction: 'next',
    });
    expect(structureKeyAction(key('ArrowUp'), {}, region)).toEqual({
      kind: 'sibling',
      direction: 'previous',
    });
    expect(structureKeyAction(key('End'), {}, region)).toEqual({
      kind: 'edge',
      edge: 'last',
    });
    expect(structureKeyAction(key('Enter'), {}, region)).toEqual({
      kind: 'drill',
    });
    expect(structureKeyAction(key('ArrowRight'), {}, region)).toEqual({
      kind: 'drill',
    });
    expect(structureKeyAction(key('ArrowLeft'), {}, region)).toEqual({
      kind: 'climb',
    });
  });

  it('leaves Left, Right, Home and End to the toolbar', () => {
    expect(structureKeyAction(key('ArrowLeft'), {}, toolbar)).toBeNull();
    expect(structureKeyAction(key('Home'), {}, toolbar)).toBeNull();
    expect(structureKeyAction(key('ArrowDown'), {}, toolbar)).toEqual({
      kind: 'sibling',
      direction: 'next',
    });
  });

  it('moves with Alt and the arrow along the siblings axis only', () => {
    expect(
      structureKeyAction(key('ArrowDown', { altKey: true }), {}, region),
    ).toEqual({ kind: 'move', direction: 'later' });
    expect(
      structureKeyAction(key('ArrowRight', { altKey: true }), {}, region),
    ).toBeNull();
    expect(
      structureKeyAction(
        key('ArrowRight', { altKey: true }),
        {},
        {
          ...region,
          axis: 'horizontal',
        },
      ),
    ).toEqual({ kind: 'move', direction: 'later' });
  });

  it('undoes and redoes with Control or Command and Z, from anywhere', () => {
    expect(
      structureKeyAction(key('z', { ctrlKey: true }), {}, elsewhere),
    ).toEqual({ kind: 'undo' });
    expect(
      structureKeyAction(
        key('Z', { metaKey: true, shiftKey: true }),
        {},
        elsewhere,
      ),
    ).toEqual({ kind: 'redo' });
  });

  it('deletes with Delete or Backspace and duplicates with Control or Command and D, from the region or the toolbar only', () => {
    for (const name of ['Delete', 'Backspace']) {
      expect(structureKeyAction(key(name), {}, region)).toEqual({
        kind: 'delete',
      });
      expect(structureKeyAction(key(name), {}, toolbar)).toEqual({
        kind: 'delete',
      });
      expect(structureKeyAction(key(name), {}, elsewhere)).toBeNull();
    }
    expect(structureKeyAction(key('d', { ctrlKey: true }), {}, region)).toEqual(
      { kind: 'duplicate' },
    );
    expect(
      structureKeyAction(key('D', { metaKey: true }), {}, toolbar),
    ).toEqual({ kind: 'duplicate' });
    expect(
      structureKeyAction(key('d', { ctrlKey: true }), {}, elsewhere),
    ).toBeNull();
    expect(structureKeyAction(key('d'), {}, region)).toBeNull();
  });

  it('does nothing while the user types, and ignores plain keys away from the region', () => {
    expect(
      structureKeyAction(
        key('z', { ctrlKey: true }),
        { tagName: 'TEXTAREA' },
        region,
      ),
    ).toBeNull();
    expect(structureKeyAction(key('ArrowDown'), {}, elsewhere)).toBeNull();
  });
});
