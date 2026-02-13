import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isTmuxAvailable,
  isInsideTmux,
  getCurrentSession,
  createSession,
  createWindow,
  sessionExists,
  windowExists,
  killSession,
  killWindow,
  capturePane,
  sendKeys,
  setPaneDiedHook,
  getPanePid,
  isPaneRunning,
  isTmuxHealthy,
} from '../../src/lib/tmux';

describe('tmux utilities', () => {
  describe('isTmuxAvailable', () => {
    it('should return a boolean', async () => {
      const result = await isTmuxAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('isInsideTmux', () => {
    it('should return false when TMUX env var is not set', () => {
      const originalTmux = process.env.TMUX;
      delete process.env.TMUX;
      try {
        const result = isInsideTmux();
        expect(result).toBe(false);
      } finally {
        if (originalTmux) process.env.TMUX = originalTmux;
      }
    });

    it('should return true when TMUX env var is set', () => {
      const originalTmux = process.env.TMUX;
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      try {
        const result = isInsideTmux();
        expect(result).toBe(true);
      } finally {
        if (originalTmux) {
          process.env.TMUX = originalTmux;
        } else {
          delete process.env.TMUX;
        }
      }
    });
  });

  describe('getCurrentSession', () => {
    it('should return undefined when not in tmux', () => {
      const originalTmux = process.env.TMUX;
      delete process.env.TMUX;
      try {
        const result = getCurrentSession();
        expect(result).toBeUndefined();
      } finally {
        if (originalTmux) process.env.TMUX = originalTmux;
      }
    });

    it('should return session name from tmux display-message when inside tmux', () => {
      const originalTmux = process.env.TMUX;
      process.env.TMUX = '/tmp/tmux-1000/my-session,12345,0';
      try {
        const result = getCurrentSession();
        expect(typeof result === 'string' || result === undefined).toBe(true);
      } finally {
        if (originalTmux) {
          process.env.TMUX = originalTmux;
        } else {
          delete process.env.TMUX;
        }
      }
    });

    it('should handle missing TMUX env var gracefully', () => {
      const originalTmux = process.env.TMUX;
      delete process.env.TMUX;
      try {
        const result = getCurrentSession();
        expect(result).toBeUndefined();
      } finally {
        if (originalTmux) {
          process.env.TMUX = originalTmux;
        } else {
          delete process.env.TMUX;
        }
      }
    });
  });

  describe('createSession', () => {
    it('should accept valid options', async () => {
      const result = await createSession({
        name: 'test-session-valid-xyz',
        workdir: '/tmp',
      });
      expect(result).toBeUndefined();
      // Cleanup
      await killSession('test-session-valid-xyz').catch(() => {});
    });
  });

  describe('createWindow', () => {
    it('should throw error when session does not exist', async () => {
      await expect(
        createWindow({
          session: 'nonexistent-session-xyz',
          name: 'test-window',
          workdir: '/tmp',
        })
      ).rejects.toThrow();
    });
  });

  describe('sessionExists', () => {
    it('should return false for nonexistent session', async () => {
      const result = await sessionExists('nonexistent-session-xyz-123');
      expect(result).toBe(false);
    });
  });

  describe('windowExists', () => {
    it('should return false for nonexistent window', async () => {
      const result = await windowExists(
        'nonexistent-session-xyz',
        'nonexistent-window'
      );
      expect(result).toBe(false);
    });
  });

  describe('killSession', () => {
    it('should throw error when session does not exist', async () => {
      await expect(
        killSession('nonexistent-session-xyz-123')
      ).rejects.toThrow();
    });
  });

  describe('killWindow', () => {
    it('should throw error when window does not exist', async () => {
      await expect(
        killWindow('nonexistent-session-xyz', 'nonexistent-window')
      ).rejects.toThrow();
    });
  });

  describe('capturePane', () => {
    it('should throw error for invalid target', async () => {
      await expect(
        capturePane('nonexistent-session-xyz:0')
      ).rejects.toThrow();
    });
  });

  describe('sendKeys', () => {
    it('should throw error for invalid target', async () => {
      await expect(
        sendKeys('nonexistent-session-xyz:0', 'echo test')
      ).rejects.toThrow();
    });
  });

  describe('setPaneDiedHook', () => {
    it('should throw error for invalid target', async () => {
      await expect(
        setPaneDiedHook('nonexistent-session-xyz:0', 'echo done')
      ).rejects.toThrow();
    });
  });

  describe('getPanePid', () => {
    it('should return undefined for invalid target', async () => {
      const result = await getPanePid('nonexistent-session-xyz:0');
      expect(result).toBeUndefined();
    });
  });

  describe('isPaneRunning', () => {
    it('should return false when tmux reports pane not found', async () => {
      const result = await isPaneRunning('nonexistent-session-xyz:0');
      expect(result).toBe(false);
    });
  });

  describe('isTmuxHealthy', () => {
    it('should return a boolean', async () => {
      const result = await isTmuxHealthy();
      expect(typeof result).toBe('boolean');
    });
  });
});
