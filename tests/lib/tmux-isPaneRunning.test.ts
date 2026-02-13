import { describe, it, expect, afterEach } from 'bun:test';
import {
  isPaneRunning,
  isTmuxHealthy,
  createSession,
  killSession,
} from '../../src/lib/tmux';

const TEST_SESSION = 'mc-test-pane-running-xyz';

describe('isPaneRunning error handling', () => {
  afterEach(async () => {
    try {
      await killSession(TEST_SESSION);
    } catch {}
  });

  it('returns false when pane does not exist', async () => {
    const result = await isPaneRunning('nonexistent-session-abc-xyz-999:0');
    expect(result).toBe(false);
  });

  it('returns true for an active pane', async () => {
    await createSession({ name: TEST_SESSION, workdir: '/tmp' });
    const result = await isPaneRunning(TEST_SESSION);
    expect(result).toBe(true);
  });

  it('returns false after killing a session', async () => {
    await createSession({ name: TEST_SESSION, workdir: '/tmp' });
    await killSession(TEST_SESSION);
    const result = await isPaneRunning(TEST_SESSION);
    expect(result).toBe(false);
  });
});

describe('isPaneRunning internal logic', () => {
  it('returns false (not throw) for various nonexistent target formats', async () => {
    const targets = [
      'nonexistent-session-aaa:0',
      'nonexistent-session-bbb:nonexistent-window',
      'no-such-sess-ccc',
    ];
    for (const target of targets) {
      const result = await isPaneRunning(target);
      expect(result).toBe(false);
    }
  });
});

describe('isTmuxHealthy', () => {
  it('returns true when tmux server is running', async () => {
    const result = await isTmuxHealthy();
    expect(result).toBe(true);
  });
});
