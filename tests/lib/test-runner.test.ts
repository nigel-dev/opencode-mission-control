import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectTestCommand, runTests } from '../../src/lib/test-runner';

let testDir: string;

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'test-runner-test-'));
}

describe('test-runner', () => {
  beforeEach(async () => {
    testDir = await createTempDir();
  });

  afterEach(async () => {
    const fs = await import('fs');
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('detectTestCommand', () => {
    it('should read scripts.test from package.json', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          test: 'vitest',
        },
      };
      await Bun.write(join(testDir, 'package.json'), JSON.stringify(packageJson));

      const command = await detectTestCommand(testDir);
      expect(command).toBe('vitest');
    });

    it('should return null when package.json does not exist', async () => {
      const command = await detectTestCommand(testDir);
      expect(command).toBeNull();
    });

    it('should return null when scripts.test is not defined', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          build: 'tsc',
        },
      };
      await Bun.write(join(testDir, 'package.json'), JSON.stringify(packageJson));

      const command = await detectTestCommand(testDir);
      expect(command).toBeNull();
    });

    it('should return null when scripts is not defined', async () => {
      const packageJson = {
        name: 'test-project',
      };
      await Bun.write(join(testDir, 'package.json'), JSON.stringify(packageJson));

      const command = await detectTestCommand(testDir);
      expect(command).toBeNull();
    });

    it('should return null on invalid JSON', async () => {
      await Bun.write(join(testDir, 'package.json'), 'invalid json {');

      const command = await detectTestCommand(testDir);
      expect(command).toBeNull();
    });

    it('should handle complex test commands', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          test: 'bun test --coverage',
        },
      };
      await Bun.write(join(testDir, 'package.json'), JSON.stringify(packageJson));

      const command = await detectTestCommand(testDir);
      expect(command).toBe('bun test --coverage');
    });
  });

  describe('runTests', () => {
    it('should skip tests when no command is provided or detected', async () => {
      const result = await runTests(testDir);

      expect(result.success).toBe(true);
      expect(result.output).toBe('No test command configured');
      expect(result.timedOut).toBe(false);
    });

    it('should run provided test command', async () => {
      const result = await runTests(testDir, 'echo "test passed"');

      expect(result.success).toBe(true);
      expect(result.output).toContain('test passed');
      expect(result.timedOut).toBe(false);
    });

    it('should auto-detect test command from package.json', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          test: 'echo "auto-detected test"',
        },
      };
      await Bun.write(join(testDir, 'package.json'), JSON.stringify(packageJson));

      const result = await runTests(testDir);

      expect(result.success).toBe(true);
      expect(result.output).toContain('auto-detected test');
      expect(result.timedOut).toBe(false);
    });

    it('should capture output from test command', async () => {
      const result = await runTests(testDir, 'echo "hello world"');

      expect(result.output).toContain('hello world');
    });

    it('should detect test failure (non-zero exit code)', async () => {
      const result = await runTests(testDir, 'exit 1');

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(false);
    });

    it('should timeout hanging test process', async () => {
      const result = await runTests(testDir, 'sleep 10', 100);

      expect(result.timedOut).toBe(true);
      expect(result.success).toBe(false);
    });

    it('should use default timeout of 10 minutes', async () => {
      const result = await runTests(testDir, 'echo "quick test"');

      expect(result.success).toBe(true);
      expect(result.timedOut).toBe(false);
    });

    it('should handle command with arguments', async () => {
      const result = await runTests(testDir, 'echo hello world');

      expect(result.output).toContain('hello');
    });

    it('should handle error in command execution', async () => {
      const result = await runTests(testDir, 'nonexistent-command-xyz');

      expect(result.success).toBe(false);
      expect(result.output).toContain('Error');
    });

    it('should prefer provided command over auto-detected', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          test: 'echo "auto-detected"',
        },
      };
      await Bun.write(join(testDir, 'package.json'), JSON.stringify(packageJson));

      const result = await runTests(testDir, 'echo "provided"');

      expect(result.output).toContain('provided');
      expect(result.output).not.toContain('auto-detected');
    });

    it('should use custom timeout when provided', async () => {
      const result = await runTests(testDir, 'echo "test"', 5000);

      expect(result.success).toBe(true);
      expect(result.timedOut).toBe(false);
    });
  });
});
