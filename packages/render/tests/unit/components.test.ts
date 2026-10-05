import {
  defineBlocks,
  type BlockDefinition,
  type PagesConfig,
  type PagesDeps,
} from '@plakboek/pages';
import { Component, createElement, forwardRef, memo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  createComponentMap,
  listInvalidBlockComponents,
} from '../../src/components.js';
import type { BlockComponent } from '../../src/index.js';
import {
  createVisitorHandler,
  VisitorHandlerConfigError,
} from '../../src/server.js';

const Plain: BlockComponent = () => createElement('p', null, 'plain');

// The block registry is process-wide, so definitions come from ONE call.
const [plainBlock, withoutComponentBlock] = defineBlocks([
  {
    key: 'plain',
    editor: { label: 'Plain' },
    schemaVersion: 1,
    component: Plain,
    properties: {},
  },
  {
    key: 'bare',
    editor: { label: 'Bare' },
    schemaVersion: 1,
    properties: {},
  },
]) as readonly [BlockDefinition, BlockDefinition];

function withComponent(key: string, component: unknown): BlockDefinition {
  return { ...plainBlock, key, component };
}

class ClassBase extends Component {
  override render(): null {
    return null;
  }
}

class NativeClass {
  render(): null {
    return null;
  }
}

const memoBlock = withComponent('memoBlock', memo(Plain));
const forwardRefBlock = withComponent(
  'forwardRefBlock',
  forwardRef(() => null),
);
const reactClassBlock = withComponent('reactClassBlock', ClassBase);
const nativeClassBlock = withComponent('nativeClassBlock', NativeClass);
const stringBlock = withComponent('stringBlock', 'section');

function configWith(blocks: readonly BlockDefinition[]): PagesConfig {
  return {
    content: {
      locales: ['en'],
      defaultLocale: 'en',
      timezone: 'Europe/Brussels',
    },
    blocks,
    sectionNestingDepth: 2,
    blockDepthCeiling: 12,
  };
}

const THROWING_DB = new Proxy(
  {},
  {
    get(): never {
      throw new Error('the database must not be touched');
    },
  },
) as PagesDeps['db'];

describe('createComponentMap', () => {
  it('keeps a block whose component is a plain function', () => {
    const map = createComponentMap([plainBlock]);
    expect(map.get('plain')).toBe(Plain);
  });

  it('leaves a block without a component out and reports it once', () => {
    const onMissingComponent = vi.fn();
    const map = createComponentMap([plainBlock, withoutComponentBlock], {
      onMissingComponent,
    });
    expect(map.has('bare')).toBe(false);
    expect(onMissingComponent).toHaveBeenCalledTimes(1);
    expect(onMissingComponent).toHaveBeenCalledWith({ blockType: 'bare' });
  });

  it('logs the block key when no hook is set, without throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      createComponentMap([withoutComponentBlock]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls[0])).toContain('bare');
    } finally {
      spy.mockRestore();
    }
  });

  it('skips invalid components silently', () => {
    const onMissingComponent = vi.fn();
    const map = createComponentMap(
      [memoBlock, forwardRefBlock, reactClassBlock, nativeClassBlock],
      { onMissingComponent },
    );
    expect(map.size).toBe(0);
    expect(onMissingComponent).not.toHaveBeenCalled();
  });

  it('survives a missing-component hook that throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const map = createComponentMap([plainBlock, withoutComponentBlock], {
        onMissingComponent: () => {
          throw new Error('hook failed');
        },
      });
      expect(map.get('plain')).toBe(Plain);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('listInvalidBlockComponents', () => {
  it.each([
    ['a memo object', memoBlock],
    ['a forwardRef object', forwardRefBlock],
    ['a class extending React.Component', reactClassBlock],
    ['a native class with no React base', nativeClassBlock],
    ['a string', stringBlock],
  ])('reports %s', (_label, block) => {
    expect(listInvalidBlockComponents([block])).toEqual([block.key]);
  });

  it('reports nothing for a plain function or an absent component', () => {
    expect(
      listInvalidBlockComponents([plainBlock, withoutComponentBlock]),
    ).toEqual([]);
  });

  it('reports every offending key and none of the valid ones', () => {
    expect(
      listInvalidBlockComponents([memoBlock, plainBlock, nativeClassBlock]),
    ).toEqual(['memoBlock', 'nativeClassBlock']);
  });
});

describe('createVisitorHandler component refusal', () => {
  it('throws one VisitorHandlerConfigError naming every invalid block', () => {
    let thrown: unknown;
    try {
      createVisitorHandler({
        db: THROWING_DB,
        config: configWith([plainBlock, memoBlock, nativeClassBlock]),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VisitorHandlerConfigError);
    const { issues } = thrown as VisitorHandlerConfigError;
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.code)).toEqual([
      'invalid-block-component',
      'invalid-block-component',
    ]);
    expect(issues[0]?.message).toContain('"memoBlock"');
    expect(issues[1]?.message).toContain('"nativeClassBlock"');
  });

  it('reports the invalid components together with another config issue in one throw', () => {
    let thrown: unknown;
    try {
      createVisitorHandler({
        db: THROWING_DB,
        config: configWith([memoBlock]),
        siteUrl: 'not a url',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VisitorHandlerConfigError);
    const codes = (thrown as VisitorHandlerConfigError).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain('INVALID_SITE_URL');
    expect(codes).toContain('invalid-block-component');
  });

  it('never refuses for a missing component, and survives a throwing hook', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const handler = createVisitorHandler({
        db: THROWING_DB,
        config: configWith([plainBlock, withoutComponentBlock]),
        hooks: {
          onMissingComponent: () => {
            throw new Error('hook failed');
          },
        },
      });
      expect(typeof handler).toBe('function');
    } finally {
      spy.mockRestore();
    }
  });
});
