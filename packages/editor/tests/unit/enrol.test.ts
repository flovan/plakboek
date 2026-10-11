/**
 * What the set-up step works out from the key the auth service hands back:
 * the secret inside the `otpauth://` link, and how it is written for a person
 * to type into an authenticator app.
 */
import { describe, expect, it } from 'vitest';
import {
  groupSetupKey,
  parseOtpauthUri,
} from '../../src/client/login/enrol.js';

describe('parseOtpauthUri', () => {
  it('reads the secret, issuer and account of an authenticator link', () => {
    expect(
      parseOtpauthUri(
        'otpauth://totp/Plakboek:a%40b.test?secret=JBSWY3DPEHPK3PXP&issuer=Plakboek',
      ),
    ).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'Plakboek',
      account: 'a@b.test',
    });
  });

  it('takes the issuer from the label when the query has none', () => {
    expect(
      parseOtpauthUri('otpauth://totp/Acme%20Site:ada%40b.test?secret=ABCD'),
    ).toEqual({ secret: 'ABCD', issuer: 'Acme Site', account: 'ada@b.test' });
  });

  it('answers null for a link that is not an authenticator link', () => {
    expect(parseOtpauthUri('https://example.com/?secret=ABCD')).toBeNull();
    expect(parseOtpauthUri('javascript:alert(1)')).toBeNull();
    expect(parseOtpauthUri('not a uri')).toBeNull();
    expect(parseOtpauthUri('')).toBeNull();
  });

  it('answers null when there is no secret', () => {
    expect(parseOtpauthUri('otpauth://totp/Plakboek:a%40b.test')).toBeNull();
    expect(
      parseOtpauthUri('otpauth://totp/Plakboek:a%40b.test?secret='),
    ).toBeNull();
  });
});

describe('groupSetupKey', () => {
  it('writes the key in groups of four', () => {
    expect(groupSetupKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });

  it('keeps a shorter last group', () => {
    expect(groupSetupKey('ABCDEFG')).toBe('ABCD EFG');
  });

  it('leaves a key of one group alone', () => {
    expect(groupSetupKey('ABC')).toBe('ABC');
  });
});
