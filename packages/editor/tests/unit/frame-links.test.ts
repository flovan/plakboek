import { describe, expect, it, vi } from 'vitest';
import {
  attachFrameLinks,
  classifyFrameNavigation,
  editShellLocation,
  type FrameClick,
} from '../../src/client/shell/frame-links.js';
import { shellTitle } from '../../src/client/shell/frame-watch.js';

const TOP = 'https://site.example';
const FRAME_URL = `${TOP}/about?_edit=frame`;

function click(overrides: Partial<FrameClick> = {}): FrameClick {
  return {
    href: '/contact',
    frameUrl: FRAME_URL,
    topOrigin: TOP,
    target: '',
    download: false,
    modifiers: {
      button: 0,
      ctrl: false,
      meta: false,
      shift: false,
      alt: false,
    },
    ...overrides,
  };
}

function withModifier(
  modifier: Partial<FrameClick['modifiers']>,
): Partial<FrameClick> {
  return { modifiers: { ...click().modifiers, ...modifier } };
}

describe('classifyFrameNavigation: follow-top', () => {
  it('follows a link to another page of the site, in edit mode', () => {
    expect(classifyFrameNavigation(click({ href: '/contact' }))).toEqual({
      action: 'follow-top',
      location: '/contact?_edit=1',
    });
  });

  it('resolves a relative link against the page it was clicked on', () => {
    expect(
      classifyFrameNavigation(
        click({ href: 'team', frameUrl: `${TOP}/about/?_edit=frame` }),
      ),
    ).toEqual({ action: 'follow-top', location: '/about/team?_edit=1' });
  });

  it('keeps the target query and replaces every _edit with one _edit=1', () => {
    expect(
      classifyFrameNavigation(
        click({ href: '/search?q=a&_edit=frame&page=2&_edit=x' }),
      ),
    ).toEqual({
      action: 'follow-top',
      location: '/search?q=a&page=2&_edit=1',
    });
  });

  it('accepts an absolute link to this origin and drops its fragment', () => {
    expect(
      classifyFrameNavigation(click({ href: `${TOP}/contact#form` })),
    ).toEqual({ action: 'follow-top', location: '/contact?_edit=1' });
  });

  it('follows a link to the same page without a fragment (a reload)', () => {
    expect(classifyFrameNavigation(click({ href: '/about' }))).toEqual({
      action: 'follow-top',
      location: '/about?_edit=1',
    });
  });

  it('follows a link with a fragment to another page', () => {
    expect(classifyFrameNavigation(click({ href: '/contact#form' }))).toEqual({
      action: 'follow-top',
      location: '/contact?_edit=1',
    });
  });

  it.each(['_self', '_top', '_parent', ' _TOP '])(
    'follows a link whose target %j names this window or a parent of it',
    (target) => {
      expect(
        classifyFrameNavigation(click({ href: '/contact', target })).action,
      ).toBe('follow-top');
    },
  );
});

describe('classifyFrameNavigation: new-tab', () => {
  it('opens a link to another origin in a new tab', () => {
    expect(
      classifyFrameNavigation(click({ href: 'https://other.example/x?a=1' })),
    ).toEqual({ action: 'new-tab', url: 'https://other.example/x?a=1' });
  });

  it('treats another port or scheme of the same host as another origin', () => {
    expect(
      classifyFrameNavigation(click({ href: 'http://site.example/x' })).action,
    ).toBe('new-tab');
    expect(
      classifyFrameNavigation(click({ href: 'https://site.example:8443/x' }))
        .action,
    ).toBe('new-tab');
  });

  it('treats a protocol-relative link to another host as another origin', () => {
    expect(
      classifyFrameNavigation(click({ href: '//other.example/x' })),
    ).toEqual({ action: 'new-tab', url: 'https://other.example/x' });
  });
});

describe('classifyFrameNavigation: allow', () => {
  it.each(['#team', '#', '/about#team', `${TOP}/about?_edit=frame#team`])(
    'leaves the link to a spot on the same page (%j) to the browser',
    (href) => {
      expect(classifyFrameNavigation(click({ href })).action).toBe('allow');
    },
  );

  it('does not mistake a fragment on another page for the same page', () => {
    expect(
      classifyFrameNavigation(click({ href: '/about?x=1#a' })).action,
    ).toBe('follow-top');
  });

  it('leaves a download to the browser', () => {
    expect(
      classifyFrameNavigation(click({ href: '/file.pdf', download: true })),
    ).toEqual({ action: 'allow' });
  });

  it.each(['_blank', 'preview', '_new'])(
    'leaves a link that names its own window (target %j) alone',
    (target) => {
      expect(
        classifyFrameNavigation(click({ href: '/contact', target })).action,
      ).toBe('allow');
      expect(
        classifyFrameNavigation(
          click({ href: 'https://other.example/', target }),
        ).action,
      ).toBe('allow');
    },
  );

  it.each([
    'mailto:a@example.com',
    'tel:+3212345678',
    'javascript:void(0)',
    'data:text/plain,x',
    'blob:https://site.example/abc',
    'ftp://site.example/x',
    'sms:+3212345678',
  ])('leaves the non-web link %j alone', (href) => {
    expect(classifyFrameNavigation(click({ href })).action).toBe('allow');
  });

  it.each([
    ['ctrl', { ctrl: true }],
    ['meta', { meta: true }],
    ['shift', { shift: true }],
    ['alt', { alt: true }],
    ['the middle button', { button: 1 }],
    ['the secondary button', { button: 2 }],
  ] as const)('leaves a click with %s alone', (_name, modifier) => {
    expect(
      classifyFrameNavigation(
        click({ href: '/contact', ...withModifier(modifier) }),
      ).action,
    ).toBe('allow');
    expect(
      classifyFrameNavigation(
        click({ href: 'https://other.example/', ...withModifier(modifier) }),
      ).action,
    ).toBe('allow');
  });

  it('leaves a link it cannot parse alone', () => {
    expect(classifyFrameNavigation(click({ href: 'http://[bad' })).action).toBe(
      'allow',
    );
    expect(
      classifyFrameNavigation(click({ frameUrl: 'not a url' })).action,
    ).toBe('allow');
  });
});

describe('editShellLocation', () => {
  it('adds _edit=1 to a path with no query', () => {
    expect(editShellLocation(new URL(`${TOP}/a`))).toBe('/a?_edit=1');
  });

  it('removes every _edit, whatever its value or position, and keeps the rest verbatim', () => {
    expect(
      editShellLocation(new URL(`${TOP}/a?_edit&x=%20y&_edit=frame&z`)),
    ).toBe('/a?x=%20y&z&_edit=1');
  });

  it('never yields a scheme-relative location for a same-origin double-slash path', () => {
    for (const href of ['/.//evil.com/x?a=1', `${TOP}//evil.com/x`]) {
      const location = editShellLocation(new URL(href, TOP));
      expect(location.startsWith('//')).toBe(false);
      expect(location.startsWith('/')).toBe(true);
    }
    expect(editShellLocation(new URL('/.//evil.com/x?a=1', TOP))).toBe(
      '/evil.com/x?a=1&_edit=1',
    );
  });

  it('keeps a double-slash link on the site when classified', () => {
    for (const href of ['/.//evil.com/x', `${TOP}//evil.com/x`]) {
      const decision = classifyFrameNavigation(click({ href }));
      expect(decision.action).toBe('follow-top');
      if (decision.action === 'follow-top') {
        expect(decision.location.startsWith('//')).toBe(false);
      }
    }
  });

  it('keeps a parameter that only starts with _edit', () => {
    expect(editShellLocation(new URL(`${TOP}/a?_editor=1`))).toBe(
      '/a?_editor=1&_edit=1',
    );
  });
});

type Listener = (event: unknown) => void;

/** A frame window that records its listeners, and a link inside it. */
function fakeWindow() {
  const listeners: { type: string; listener: Listener; rest: unknown[] }[] = [];
  const frameWindow = {
    addEventListener: vi.fn(
      (type: string, listener: Listener, ...rest: unknown[]) => {
        listeners.push({ type, listener, rest });
      },
    ),
    removeEventListener: vi.fn(),
  } as unknown as Window;
  return { frameWindow, listeners };
}

function fakeLink(attributes: Record<string, string>) {
  const link = {
    ownerDocument: { baseURI: FRAME_URL, URL: FRAME_URL },
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    closest: () => link,
  };
  return link;
}

function fakeEvent(target: unknown, overrides: Record<string, unknown> = {}) {
  return {
    target,
    defaultPrevented: false,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  };
}

function shellDouble() {
  return {
    topOrigin: TOP,
    followTop: vi.fn(),
    openTab: vi.fn(),
  };
}

describe('attachFrameLinks', () => {
  it('adds one click listener in the bubble phase', () => {
    const { frameWindow, listeners } = fakeWindow();
    attachFrameLinks(frameWindow, shellDouble());
    expect(listeners).toHaveLength(1);
    expect(listeners[0]?.type).toBe('click');
    // no options and no capture flag: the default is the bubble phase
    expect(listeners[0]?.rest).toEqual([]);
  });

  it('attaches once per window, and again after it is detached', () => {
    const { frameWindow, listeners } = fakeWindow();
    const detach = attachFrameLinks(frameWindow, shellDouble());
    attachFrameLinks(frameWindow, shellDouble());
    expect(listeners).toHaveLength(1);
    detach();
    attachFrameLinks(frameWindow, shellDouble());
    expect(listeners).toHaveLength(2);
  });

  it('follows a same-site link at the top, taking over only that default', () => {
    const { frameWindow, listeners } = fakeWindow();
    const shell = shellDouble();
    attachFrameLinks(frameWindow, shell);
    const event = fakeEvent(fakeLink({ href: '/contact' }));
    listeners[0]?.listener(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(shell.followTop).toHaveBeenCalledWith('/contact?_edit=1');
    expect(shell.openTab).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('opens another site in a new tab', () => {
    const { frameWindow, listeners } = fakeWindow();
    const shell = shellDouble();
    attachFrameLinks(frameWindow, shell);
    const event = fakeEvent(fakeLink({ href: 'https://other.example/x' }));
    listeners[0]?.listener(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(shell.openTab).toHaveBeenCalledWith('https://other.example/x');
    expect(shell.followTop).not.toHaveBeenCalled();
  });

  it('does nothing when the site already prevented the default', () => {
    const { frameWindow, listeners } = fakeWindow();
    const shell = shellDouble();
    attachFrameLinks(frameWindow, shell);
    const event = fakeEvent(fakeLink({ href: '/contact' }), {
      defaultPrevented: true,
    });
    listeners[0]?.listener(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(shell.followTop).not.toHaveBeenCalled();
    expect(shell.openTab).not.toHaveBeenCalled();
  });

  it('does nothing for a click outside any link', () => {
    const { frameWindow, listeners } = fakeWindow();
    const shell = shellDouble();
    attachFrameLinks(frameWindow, shell);
    const button = { closest: () => null };
    for (const target of [button, null, {}]) {
      const event = fakeEvent(target);
      listeners[0]?.listener(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(shell.followTop).not.toHaveBeenCalled();
  });

  it('leaves hash links, downloads, named windows and modified clicks to the browser', () => {
    const { frameWindow, listeners } = fakeWindow();
    const shell = shellDouble();
    attachFrameLinks(frameWindow, shell);
    const cases: [Record<string, string>, Record<string, unknown>][] = [
      [{ href: '#team' }, {}],
      [{ href: '/file.pdf', download: '' }, {}],
      [{ href: '/contact', target: '_blank' }, {}],
      [{ href: 'mailto:a@example.com' }, {}],
      [{ href: '/contact' }, { ctrlKey: true }],
      [{ href: '/contact' }, { button: 1 }],
    ];
    for (const [attributes, overrides] of cases) {
      const event = fakeEvent(fakeLink(attributes), overrides);
      listeners[0]?.listener(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(shell.followTop).not.toHaveBeenCalled();
    expect(shell.openTab).not.toHaveBeenCalled();
  });

  it('resolves a link against the document base, so a base element is honoured', () => {
    const { frameWindow, listeners } = fakeWindow();
    const shell = shellDouble();
    attachFrameLinks(frameWindow, shell);
    const link = fakeLink({ href: 'team' });
    link.ownerDocument.baseURI = `${TOP}/company/`;
    listeners[0]?.listener(fakeEvent(link));
    expect(shell.followTop).toHaveBeenCalledWith('/company/team?_edit=1');
  });
});

describe('shellTitle', () => {
  it('puts the product name after the page title', () => {
    expect(shellTitle('About us')).toBe('About us · Plakboek');
  });

  it('is the product name alone when the page has no title', () => {
    expect(shellTitle('')).toBe('Plakboek');
    expect(shellTitle('   ')).toBe('Plakboek');
  });
});
