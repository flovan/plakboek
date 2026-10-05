import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultSiteName,
  packageNameFromDir,
  parseLocaleList,
  validateDirectory,
  validateLocale,
  validateSiteName,
} from '../../src/validate.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'create-plakboek-validate-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('validateDirectory', () => {
  it('accepts a directory that does not exist', () => {
    expect(validateDirectory(join(root, 'absent'))).toEqual({
      ok: true,
      value: join(root, 'absent'),
    });
  });

  it('accepts an empty directory', async () => {
    const dir = join(root, 'empty');
    await mkdir(dir);
    expect(validateDirectory(dir).ok).toBe(true);
  });

  it('refuses a directory that holds a file', async () => {
    const dir = join(root, 'full');
    await mkdir(dir);
    await writeFile(join(dir, 'keep.txt'), 'x');
    expect(validateDirectory(dir)).toEqual({
      ok: false,
      message: `"${dir}" is not empty. Choose another directory or empty this one.`,
    });
  });

  it('refuses a path that is a regular file', async () => {
    const file = join(root, 'file.txt');
    await writeFile(file, 'x');
    expect(validateDirectory(file)).toEqual({
      ok: false,
      message: `"${file}" is not empty. Choose another directory or empty this one.`,
    });
  });
});

describe('validateSiteName', () => {
  const message = 'Enter a site name of 1 to 200 characters.';

  it('refuses an empty name', () => {
    expect(validateSiteName('')).toEqual({ ok: false, message });
    expect(validateSiteName('   ')).toEqual({ ok: false, message });
  });

  it('refuses a name longer than 200 characters', () => {
    expect(validateSiteName('a'.repeat(201))).toEqual({ ok: false, message });
    expect(validateSiteName('a'.repeat(200)).ok).toBe(true);
  });

  it('refuses control characters', () => {
    expect(validateSiteName('two\nlines')).toEqual({ ok: false, message });
    expect(validateSiteName('tab\there')).toEqual({ ok: false, message });
    expect(validateSiteName('nul\u0000')).toEqual({ ok: false, message });
  });

  it('accepts quotes, ampersands and markup as plain text', () => {
    const name = 'Acme & Co "Ltd" </script>';
    expect(validateSiteName(name)).toEqual({ ok: true, value: name });
  });
});

describe('validateLocale', () => {
  it('accepts language tags', () => {
    for (const locale of ['en', 'nl', 'pt-br']) {
      expect(validateLocale(locale)).toEqual({ ok: true, value: locale });
    }
  });

  it('refuses anything else with the S3 copy', () => {
    for (const locale of ['EN', 'english', 'e']) {
      expect(validateLocale(locale)).toEqual({
        ok: false,
        message: `"${locale}" is not a valid locale. Use a language tag such as en or nl.`,
      });
    }
  });
});

describe('parseLocaleList', () => {
  it('splits, trims and keeps the order', () => {
    expect(parseLocaleList('nl, de', 'en')).toEqual({
      ok: true,
      value: ['nl', 'de'],
    });
  });

  it('treats a blank list as none', () => {
    expect(parseLocaleList('', 'en')).toEqual({ ok: true, value: [] });
    expect(parseLocaleList('  ', 'en')).toEqual({ ok: true, value: [] });
  });

  it('names the first bad value', () => {
    expect(parseLocaleList('nl,,x1', 'en')).toEqual({
      ok: false,
      message:
        '"x1" is not a valid locale. Use a language tag such as en or nl.',
    });
  });

  it('removes the default locale and duplicates', () => {
    expect(parseLocaleList('en, nl, nl', 'en')).toEqual({
      ok: true,
      value: ['nl'],
    });
  });
});

describe('packageNameFromDir', () => {
  it('derives an npm-valid name', () => {
    expect(packageNameFromDir('My Site!')).toBe('my-site');
    expect(packageNameFromDir('/work/Acme Corp.com')).toBe('acme-corp.com');
    expect(packageNameFromDir('_private')).toBe('private');
  });

  it('falls back when nothing usable remains', () => {
    expect(packageNameFromDir('..')).toBe('plakboek-site');
    expect(packageNameFromDir('')).toBe('plakboek-site');
  });
});

describe('defaultSiteName', () => {
  it('title-cases the directory name', () => {
    expect(defaultSiteName('my-plakboek-site')).toBe('My Plakboek Site');
    expect(defaultSiteName('/work/acme_corp')).toBe('Acme Corp');
  });
});
