import { describe, expect, it } from 'vitest';
import { parseMeetingCode } from './meetings.service';
import { safeReturnUrl } from './return-url';
import { initials } from '../shared/user-menu';

describe('parseMeetingCode', () => {
  it.each([
    ['abc-defg-hij', 'abc-defg-hij'],
    ['  ABC-DEFG-HIJ ', 'abc-defg-hij'],
    ['abcdefghij', 'abc-defg-hij'],
    ['https://meet.example.com/abc-defg-hij', 'abc-defg-hij'],
    ['http://localhost:4200/abc-defg-hij/insights', 'abc-defg-hij'],
  ])('%s → %s', (input, code) => expect(parseMeetingCode(input)).toBe(code));

  it.each(['', 'abc-def-hij', 'abc-defg-hijk', 'hello world', 'abc1defghij'])('rejects %j', (input) =>
    expect(parseMeetingCode(input)).toBeNull(),
  );
});

describe('safeReturnUrl (open-redirect guard)', () => {
  it.each([
    ['/abc-defg-hij', '/abc-defg-hij'],
    ['/account', '/account'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['https://evil.com', '/'],
    ['javascript:alert(1)', '/'],
    [null, '/'],
  ])('%j → %s', (input, out) => expect(safeReturnUrl(input as string | null)).toBe(out));
});

describe('initials', () => {
  it.each([
    ['Asha Rao', 'AR'],
    ['ravi', 'R'],
    ['  Mary Ann  Lee ', 'ML'],
    ['', '?'],
  ])('%j → %s', (name, out) => expect(initials(name)).toBe(out));
});
