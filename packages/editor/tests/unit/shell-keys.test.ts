import { describe, expect, it } from 'vitest';
import { isEditableTarget, keyAction } from '../../src/client/shell/keys.js';

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
