import { describe, it, expect } from 'vitest';
import { assertValidJobName, validateJobName } from '../../src/lib/job-name';

describe('validateJobName', () => {
  it.each(['fix-login', 'Fix_login-2.1', 'a', '0day', 'v1.2.3'])('accepts %p', (name) => {
    expect(validateJobName(name)).toBeUndefined();
  });

  it.each([
    ['', 'A job name is required.'],
    ['   ', 'A job name is required.'],
    ['has space', 'Use letters, digits, dots, dashes and underscores only.'],
    ['a/b', 'Use letters, digits, dots, dashes and underscores only.'],
    ['../escape', 'Use letters, digits, dots, dashes and underscores only.'],
    ['-leading-dash', 'Use letters, digits, dots, dashes and underscores only.'],
    ['.hidden', 'Use letters, digits, dots, dashes and underscores only.'],
    ['semi;colon', 'Use letters, digits, dots, dashes and underscores only.'],
    ['$(whoami)', 'Use letters, digits, dots, dashes and underscores only.'],
    ['a..b', 'A job name cannot contain "..", or end with "." or ".lock".'],
    ['trailing.', 'A job name cannot contain "..", or end with "." or ".lock".'],
    ['branch.lock', 'A job name cannot contain "..", or end with "." or ".lock".'],
    ['x'.repeat(101), 'Use at most 100 characters.'],
  ])('rejects %p', (name, problem) => {
    expect(validateJobName(name)).toBe(problem);
  });

  it('ignores surrounding whitespace, as the TUI prompt does', () => {
    expect(validateJobName('  fix-login  ')).toBeUndefined();
  });
});

describe('assertValidJobName', () => {
  it('throws with the name and the reason', () => {
    expect(() => assertValidJobName('has space')).toThrow(
      'Invalid job name "has space": Use letters, digits, dots, dashes and underscores only.',
    );
  });

  it('passes a valid name', () => {
    expect(() => assertValidJobName('fix-login')).not.toThrow();
  });
});
