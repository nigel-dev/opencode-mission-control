/**
 * In-process mutex for serializing git operations.
 * Prevents concurrent git commands from corrupting the .git directory.
 *
 * Uses a Promise-based queue (no file-based locking) since all git operations
 * originate from this single process.
 */
export class GitMutex {
  private queue: Array<{
    resolve: (release: () => void) => void;
  }> = [];
  private locked = false;

  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve(this.createRelease());
        return;
      }
      this.queue.push({ resolve });
    });
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = this.queue.shift();
      if (next) {
        next.resolve(this.createRelease());
      } else {
        this.locked = false;
      }
    };
  }
}

const defaultMutex = new GitMutex();
export default defaultMutex;
