import { describe, expect, it } from 'vitest';
import { validateBootstrapInput } from '../../src/runtime/bootstrap.js';

const valid = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'correct horse battery',
} as const;

function messages(input: Parameters<typeof validateBootstrapInput>[0]) {
  return validateBootstrapInput(input).map((issue) => issue.message);
}

describe('validateBootstrapInput', () => {
  it('accepts a valid input', () => {
    expect(validateBootstrapInput(valid)).toEqual([]);
    expect(
      validateBootstrapInput({ ...valid, passwordConfirm: valid.password }),
    ).toEqual([]);
  });

  it('refuses a blank name', () => {
    expect(messages({ ...valid, name: '   ' })).toEqual([
      'Name: enter your name.',
    ]);
  });

  it('refuses a name over 200 characters and accepts exactly 200', () => {
    expect(messages({ ...valid, name: 'a'.repeat(201) })).toEqual([
      'Name: use at most 200 characters.',
    ]);
    expect(messages({ ...valid, name: 'a'.repeat(200) })).toEqual([]);
  });

  it('refuses a malformed email and one over 320 characters', () => {
    const expected = ['Email address: enter an address like name@example.com.'];
    expect(messages({ ...valid, email: 'not-an-email' })).toEqual(expected);
    expect(
      messages({ ...valid, email: `${'a'.repeat(320)}@example.com` }),
    ).toEqual(expected);
  });

  it('counts the password in code points', () => {
    const issue = ['Password: use at least 12 characters.'];
    expect(messages({ ...valid, password: 'a'.repeat(11) })).toEqual(issue);
    expect(messages({ ...valid, password: 'a'.repeat(12) })).toEqual([]);
    // Eleven emoji are eleven characters, not twenty-two.
    expect(messages({ ...valid, password: '😀'.repeat(11) })).toEqual(issue);
    expect(messages({ ...valid, password: '😀'.repeat(12) })).toEqual([]);
  });

  it('refuses a confirmation that differs and never echoes the password', () => {
    const result = validateBootstrapInput({
      ...valid,
      passwordConfirm: 'something else entirely',
    });
    expect(result.map((issue) => issue.message)).toEqual([
      'Confirm password: the two passwords do not match.',
    ]);
    expect(result[0]?.field).toBe('passwordConfirm');
    expect(JSON.stringify(result)).not.toContain(valid.password);
  });

  it('reports every problem at once, each tied to a field', () => {
    const result = validateBootstrapInput({
      name: '',
      email: 'x',
      password: 'short',
      passwordConfirm: 'other',
    });
    expect(result.map((issue) => issue.field)).toEqual([
      'name',
      'email',
      'password',
      'passwordConfirm',
    ]);
  });
});
