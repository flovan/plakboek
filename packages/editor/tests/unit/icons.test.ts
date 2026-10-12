import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AlertIcon,
  ExitIcon,
  ExpandIcon,
  FrameIcon,
  LogOutIcon,
  SpinnerIcon,
} from '../../src/chrome/icons.js';

const ICONS = {
  FrameIcon,
  ExpandIcon,
  ExitIcon,
  LogOutIcon,
  SpinnerIcon,
  AlertIcon,
} as const;

describe('icons', () => {
  it('draws six distinct icons in currentColor, hidden from assistive technology', () => {
    const markups = Object.values(ICONS).map((Icon) =>
      renderToStaticMarkup(createElement(Icon)),
    );
    expect(new Set(markups).size).toBe(6);
    for (const markup of markups) {
      expect(markup).toContain('stroke="currentColor"');
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('focusable="false"');
    }
  });

  it('defaults to 16px and accepts the 20px size, in px attributes only', () => {
    const small = renderToStaticMarkup(createElement(FrameIcon));
    const large = renderToStaticMarkup(createElement(FrameIcon, { size: 20 }));
    expect(small).toContain('width="16" height="16"');
    expect(large).toContain('width="20" height="20"');
  });

  it('rotates the spinner only when animated, and only where motion is allowed', () => {
    const animated = renderToStaticMarkup(createElement(SpinnerIcon));
    const still = renderToStaticMarkup(
      createElement(SpinnerIcon, { animated: false }),
    );
    expect(animated).toContain('motion-safe:animate-spin');
    expect(still).not.toContain('animate-spin');
    expect(still).toContain('<path');
  });
});
