/**
 * The edit seam's static half: the bounce location helper and the inert
 * toolbar bootstrap. The bootstrap is executed with `node:vm` against
 * hand-written browser stubs that record what it does, plus the real `URL`.
 */
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  EDIT_PARAM,
  EDITOR_FLAG_KEY,
  TOOLBAR_DISMISSED_KEY,
} from '../../src/constants.js';
import {
  editBounceLocation,
  renderToolbarBootstrap,
  TOOLBAR_BOOTSTRAP_CSP_HASH,
} from '../../src/edit-seam.js';

function bounce(href: string): string {
  return editBounceLocation(new URL(href));
}

describe('editBounceLocation', () => {
  it.each([
    ['http://visitor.test/about-us?_edit=1', '/about-us'],
    ['http://visitor.test/about-us?_edit=1&utm=x', '/about-us?utm=x'],
    ['http://visitor.test/about-us?utm=x&_edit&_edit=2', '/about-us?utm=x'],
    ['http://visitor.test/about-us?a=b%20c&_edit=1', '/about-us?a=b%20c'],
    ['http://visitor.test/about-us?%5Fedit=1', '/about-us'],
    ['http://visitor.test/about-us', '/about-us'],
    ['http://visitor.test/?_edit=1', '/'],
  ])('%s -> %s', (href, expected) => {
    expect(bounce(href)).toBe(expected);
  });

  it('never produces a protocol-relative location', () => {
    expect(bounce('http://visitor.test//evil.example/x?_edit=1')).toBe(
      '/evil.example/x',
    );
    expect(bounce('http://visitor.test////evil.example?_edit=1')).toBe(
      '/evil.example',
    );
  });
});

type StubElement = {
  readonly tag: string;
  textContent: string;
  type: string;
  removed: boolean;
  readonly children: StubElement[];
  readonly attributes: Record<string, string>;
  readonly listeners: Record<string, () => void>;
  shadowInit: { mode: string } | null;
  shadow: StubElement | null;
  addEventListener(name: string, listener: () => void): void;
  appendChild(child: StubElement): StubElement;
  setAttribute(name: string, value: string): void;
  attachShadow(init: { mode: string }): StubElement;
  remove(): void;
};

function createStubElement(tag: string): StubElement {
  const element: StubElement = {
    tag,
    textContent: '',
    type: '',
    removed: false,
    children: [],
    attributes: {},
    listeners: {},
    shadowInit: null,
    shadow: null,
    addEventListener(name, listener) {
      element.listeners[name] = listener;
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      element.attributes[name] = value;
    },
    attachShadow(init) {
      element.shadowInit = init;
      element.shadow = createStubElement('#shadow-root');
      return element.shadow;
    },
    remove() {
      element.removed = true;
    },
  };
  return element;
}

type Run = {
  readonly appended: StubElement[];
  readonly created: StubElement[];
  readonly assigned: string[];
  readonly storage: Map<string, string>;
};

type RunOptions = {
  readonly href?: string;
  readonly storage?: Record<string, string>;
  readonly throwingStorage?: boolean;
};

/** Executes the bootstrap against the stubs. */
function run(options: RunOptions = {}): Run {
  const storage = new Map(Object.entries(options.storage ?? {}));
  const appended: StubElement[] = [];
  const created: StubElement[] = [];
  const assigned: string[] = [];
  const sandbox: Record<string, unknown> = {
    URL,
    location: {
      href: options.href ?? 'https://site.test/about-us?x=1',
      assign: (target: string) => {
        assigned.push(target);
      },
    },
    document: {
      createElement: (tag: string) => {
        const element = createStubElement(tag);
        created.push(element);
        return element;
      },
      body: {
        appendChild: (child: StubElement) => {
          appended.push(child);
          return child;
        },
      },
    },
  };
  sandbox.window = sandbox;
  if (options.throwingStorage === true) {
    Object.defineProperty(sandbox, 'localStorage', {
      get() {
        throw new Error('storage is blocked');
      },
    });
  } else {
    sandbox.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };
  }
  const html = renderToolbarBootstrap();
  const source = html.slice('<script>'.length, -'</script>'.length);
  runInNewContext(source, sandbox);
  return { appended, created, assigned, storage };
}

const ACTIVE = { [EDITOR_FLAG_KEY]: '1' };

function buttonLabelled(host: StubElement, label: string): StubElement {
  const wrapper = host.shadow?.children.find((child) => child.tag === 'div');
  const button = wrapper?.children.find(
    (child) => child.tag === 'button' && child.textContent === label,
  );
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  return button;
}

describe('the toolbar bootstrap at run time', () => {
  it('does nothing when the editor flag is absent', () => {
    const result = run();
    expect(result.created).toHaveLength(0);
    expect(result.appended).toHaveLength(0);
  });

  it('shows one Edit pill in a closed shadow root when flagged', () => {
    const result = run({ storage: ACTIVE });
    expect(result.appended).toHaveLength(1);
    const host = result.appended[0]!;
    expect(host.tag).toBe('plakboek-toolbar');
    expect(host.shadowInit).toEqual({ mode: 'closed' });
    expect(buttonLabelled(host, 'Edit').type).toBe('button');
  });

  it('navigates to the same URL with _edit=1 on activation', () => {
    const result = run({ storage: ACTIVE });
    buttonLabelled(result.appended[0]!, 'Edit').listeners.click?.();
    expect(result.assigned).toEqual([`/about-us?x=1&${EDIT_PARAM}=1`]);
  });

  it('is inert once the toolbar was dismissed', () => {
    const result = run({
      storage: { ...ACTIVE, [TOOLBAR_DISMISSED_KEY]: '1' },
    });
    expect(result.appended).toHaveLength(0);
  });

  it('records the dismissal and removes the pill', () => {
    const result = run({ storage: ACTIVE });
    const host = result.appended[0]!;
    const dismiss = host.shadow?.children
      .find((child) => child.tag === 'div')
      ?.children.find((child) => child.attributes['aria-label'] === 'Dismiss');
    expect(dismiss).toBeDefined();
    dismiss?.listeners.click?.();
    expect(result.storage.get(TOOLBAR_DISMISSED_KEY)).toBe('1');
    expect(host.removed).toBe(true);
  });

  it('is inert when the current URL already carries _edit', () => {
    const result = run({
      storage: ACTIVE,
      href: 'https://site.test/about-us?_edit=1',
    });
    expect(result.appended).toHaveLength(0);
  });

  it('lets no exception escape when storage access throws', () => {
    expect(() => run({ throwingStorage: true })).not.toThrow();
    expect(run({ throwingStorage: true }).appended).toHaveLength(0);
  });

  it('ignores any flag value other than 1', () => {
    expect(
      run({ storage: { [EDITOR_FLAG_KEY]: 'true' } }).appended,
    ).toHaveLength(0);
  });
});

describe('the toolbar bootstrap as text', () => {
  const html = renderToolbarBootstrap();
  const body = html.slice('<script>'.length, -'</script>'.length);

  it('is the same string on every call', () => {
    expect(renderToolbarBootstrap()).toBe(renderToolbarBootstrap());
  });

  it('is one framework-free script element within the size budget', () => {
    expect(html.startsWith('<script>')).toBe(true);
    expect(html.endsWith('</script>')).toBe(true);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(body).not.toContain('</script');
    expect(body).not.toContain('data-');
    expect(body).not.toContain('innerHTML');
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('exports the sha256 of exactly the script text as its CSP hash', () => {
    const expected = `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
    expect(TOOLBAR_BOOTSTRAP_CSP_HASH).toBe(expected);
  });
});
