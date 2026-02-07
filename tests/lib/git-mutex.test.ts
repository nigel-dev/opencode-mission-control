import { describe, it, expect, beforeEach } from 'vitest';
import { GitMutex } from '../../src/lib/git-mutex';

describe('GitMutex', () => {
  let mutex: GitMutex;

  beforeEach(() => {
    mutex = new GitMutex();
  });

  describe('acquire', () => {
    it('should acquire lock when unlocked', async () => {
      const release = await mutex.acquire();
      expect(mutex.isLocked).toBe(true);
      release();
    });

    it('should release lock correctly', async () => {
      const release = await mutex.acquire();
      expect(mutex.isLocked).toBe(true);
      release();
      expect(mutex.isLocked).toBe(false);
    });

    it('should queue when already locked', async () => {
      const release1 = await mutex.acquire();
      expect(mutex.pending).toBe(0);

      const promise2 = mutex.acquire();
      expect(mutex.pending).toBe(1);

      release1();
      const release2 = await promise2;
      expect(mutex.pending).toBe(0);
      expect(mutex.isLocked).toBe(true);
      release2();
    });

    it('should process queue in FIFO order', async () => {
      const order: number[] = [];
      const release1 = await mutex.acquire();

      const p2 = mutex.acquire().then((release) => {
        order.push(2);
        release();
      });

      const p3 = mutex.acquire().then((release) => {
        order.push(3);
        release();
      });

      expect(mutex.pending).toBe(2);
      release1();

      await p2;
      await p3;

      expect(order).toEqual([2, 3]);
    });

    it('should handle double-release safely', async () => {
      const release = await mutex.acquire();
      release();
      release();
      expect(mutex.isLocked).toBe(false);
    });
  });

  describe('withLock', () => {
    it('should execute function while holding lock', async () => {
      let wasLocked = false;
      await mutex.withLock(async () => {
        wasLocked = mutex.isLocked;
      });

      expect(wasLocked).toBe(true);
      expect(mutex.isLocked).toBe(false);
    });

    it('should return function result', async () => {
      const result = await mutex.withLock(async () => 42);
      expect(result).toBe(42);
    });

    it('should release lock even if function throws', async () => {
      await expect(
        mutex.withLock(async () => {
          throw new Error('test error');
        }),
      ).rejects.toThrow('test error');

      expect(mutex.isLocked).toBe(false);
    });

    it('should serialize concurrent withLock calls', async () => {
      const events: string[] = [];

      const p1 = mutex.withLock(async () => {
        events.push('start-1');
        await new Promise((r) => setTimeout(r, 50));
        events.push('end-1');
      });

      const p2 = mutex.withLock(async () => {
        events.push('start-2');
        await new Promise((r) => setTimeout(r, 10));
        events.push('end-2');
      });

      await Promise.all([p1, p2]);

      expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    });
  });

  describe('state inspection', () => {
    it('should report pending count accurately', async () => {
      expect(mutex.pending).toBe(0);

      const release = await mutex.acquire();
      expect(mutex.pending).toBe(0);

      const p1 = mutex.acquire();
      const p2 = mutex.acquire();
      expect(mutex.pending).toBe(2);

      release();
      const r1 = await p1;
      expect(mutex.pending).toBe(1);

      r1();
      const r2 = await p2;
      expect(mutex.pending).toBe(0);
      r2();
    });

    it('should start unlocked', () => {
      expect(mutex.isLocked).toBe(false);
      expect(mutex.pending).toBe(0);
    });
  });
});
