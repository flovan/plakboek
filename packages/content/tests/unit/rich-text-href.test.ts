import { describe, expect, it } from 'vitest';
import {
  CUSTOM_SIZE_MAX,
  CUSTOM_SIZE_MIN,
  HREF_MAX_LENGTH,
  isAllowedHref,
  isCompleteLinkTarget,
  isCustomColorValue,
  isCustomSizeValue,
  linkTargetSchema,
  PAGE_ID_PATTERN,
  parseCustomColor,
  parseCustomSize,
  TOKEN_PATTERN,
} from '../../src/rich-text/index.js';

describe('isAllowedHref', () => {
  it.each([
    'https://example.com',
    'http://example.com/a?b=1#c',
    'HTTPS://EXAMPLE.COM',
    'mailto:a@b.c',
    'tel:+3212345678',
    '/about',
    '/',
    '#top',
    '#',
  ])('accepts %s', (value) => {
    expect(isAllowedHref(value)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,hi',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com',
    '//example.com',
    '/\\example.com',
    'about',
    'example.com',
    '',
    'https://',
    'https:///',
    'mailto:',
    'tel:',
    ' /about',
    '/about ',
    '/ab out',
    '/about\n',
    '/about\u0000',
    '/about\u007f',
    '/about\u0085',
    '/about ',
    'java\tscript:alert(1)',
  ])('refuses %j', (value) => {
    expect(isAllowedHref(value)).toBe(false);
  });

  it('caps a target at HREF_MAX_LENGTH characters', () => {
    expect(HREF_MAX_LENGTH).toBe(2048);
    expect(isAllowedHref(`/${'a'.repeat(HREF_MAX_LENGTH - 1)}`)).toBe(true);
    expect(isAllowedHref(`/${'a'.repeat(HREF_MAX_LENGTH)}`)).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    expect(isAllowedHref(undefined as unknown as string)).toBe(false);
    expect(isAllowedHref(3 as unknown as string)).toBe(false);
  });
});

describe('custom values', () => {
  it('parses a hex colour as typed and refuses everything else', () => {
    expect(parseCustomColor('#1d4ed8')).toBe('#1d4ed8');
    expect(parseCustomColor('  #FFF ')).toBe('#FFF');
    expect(parseCustomColor('#abcd')).toBe('#abcd');
    expect(parseCustomColor('#1D4ED880')).toBe('#1D4ED880');
    for (const value of [
      '#12345',
      '#1234567',
      '#12',
      '#ggg',
      'red',
      'rgb(0,0,0)',
      '1d4ed8',
      '',
      '#fff; color: red',
      'url(x)',
    ]) {
      expect(parseCustomColor(value)).toBeNull();
    }
  });

  it('answers whether a stored colour value is a literal as written', () => {
    expect(isCustomColorValue('#1d4ed8')).toBe(true);
    expect(isCustomColorValue('#1D4ED880')).toBe(true);
    expect(isCustomColorValue(' #fff')).toBe(false);
    expect(isCustomColorValue('red')).toBe(false);
  });

  it('parses a whole px size between the bounds', () => {
    expect([CUSTOM_SIZE_MIN, CUSTOM_SIZE_MAX]).toEqual([8, 200]);
    expect(parseCustomSize(18)).toBe('18px');
    expect(parseCustomSize('18')).toBe('18px');
    expect(parseCustomSize(' 18px ')).toBe('18px');
    expect(parseCustomSize('8')).toBe('8px');
    expect(parseCustomSize(200)).toBe('200px');
    for (const value of [
      7,
      201,
      '7px',
      '201px',
      '18.5',
      18.5,
      '2em',
      '-12',
      '',
      'big',
      '18px;',
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(parseCustomSize(value)).toBeNull();
    }
  });

  it('answers whether a stored size value is canonical px within the bounds', () => {
    expect(isCustomSizeValue('18px')).toBe(true);
    expect(isCustomSizeValue('8px')).toBe(true);
    expect(isCustomSizeValue('200px')).toBe(true);
    expect(isCustomSizeValue('7px')).toBe(false);
    expect(isCustomSizeValue('201px')).toBe(false);
    expect(isCustomSizeValue('18')).toBe(false);
    expect(isCustomSizeValue('018px')).toBe(false);
  });

  it('matches token names case-sensitively', () => {
    expect(TOKEN_PATTERN.test('accent')).toBe(true);
    expect(TOKEN_PATTERN.test('text-muted')).toBe(true);
    expect(TOKEN_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(TOKEN_PATTERN.test('a'.repeat(65))).toBe(false);
    expect(TOKEN_PATTERN.test('Accent')).toBe(false);
    expect(TOKEN_PATTERN.test('1st')).toBe(false);
    expect(TOKEN_PATTERN.test('a b')).toBe(false);
  });
});

describe('link targets', () => {
  const pageId = '0b5f4c1e-3c52-4a53-9a61-2f2b9d0f7c11';

  it('matches a lowercase uuid page id only', () => {
    expect(PAGE_ID_PATTERN.test(pageId)).toBe(true);
    expect(PAGE_ID_PATTERN.test(pageId.toUpperCase())).toBe(false);
    expect(PAGE_ID_PATTERN.test('home')).toBe(false);
  });

  it('accepts exactly one of href and page id, with an optional new-tab target', () => {
    expect(linkTargetSchema.parse({ href: '/about' })).toEqual({
      href: '/about',
      pageId: null,
      target: null,
    });
    expect(linkTargetSchema.parse({ pageId, target: '_blank' })).toEqual({
      href: null,
      pageId,
      target: '_blank',
    });
  });

  it('refuses both, neither, a bad href, a bad page id, another target and unknown keys', () => {
    for (const value of [
      { href: '/a', pageId },
      {},
      { href: 'javascript:alert(1)' },
      { pageId: 'home' },
      { href: '/a', target: '_self' },
      { href: '/a', rel: 'x' },
    ]) {
      expect(linkTargetSchema.safeParse(value).success).toBe(false);
    }
  });

  it('tells a finished link target from an unfinished one', () => {
    expect(isCompleteLinkTarget({ href: '/a' })).toBe(true);
    expect(isCompleteLinkTarget({ pageId })).toBe(true);
    expect(isCompleteLinkTarget({ href: null, pageId: null })).toBe(false);
    expect(isCompleteLinkTarget({ href: '/a', pageId })).toBe(false);
    expect(isCompleteLinkTarget({ href: 'javascript:x' })).toBe(false);
    expect(isCompleteLinkTarget({})).toBe(false);
  });
});
