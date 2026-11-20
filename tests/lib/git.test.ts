import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { gitCommand } from '../../src/lib/git';
import { spawn } from 'bun';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('gitCommand', () => {
  let testRepo: string;

  beforeEach(async () => {
    testRepo = mkdtempSync(join(tmpdir(), 'git-test-'));
    const initProc = spawn(['git', 'init'], {
      cwd: testRepo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await initProc.exited;

    const configProc = spawn(['git', 'config', 'user.email', 'test@example.com'], {
      cwd: testRepo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await configProc.exited;

    const nameProc = spawn(['git', 'config', 'user.name', 'Test User'], {
      cwd: testRepo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await nameProc.exited;
  });

  afterEach(() => {
    rmSync(testRepo, { recursive: true, force: true });
  });

  it('should execute git commands successfully', async () => {
    const result = await gitCommand(['status'], { cwd: testRepo });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('On branch');
  });

  it('should capture stderr on failure', async () => {
    const result = await gitCommand(['merge', 'nonexistent-branch'], { cwd: testRepo });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('should serialize concurrent git operations through mutex', async () => {
    const results: string[] = [];

    const operation1 = gitCommand(['status'], { cwd: testRepo }).then((r) => {
      results.push('op1');
      return r;
    });

    const operation2 = gitCommand(['status'], { cwd: testRepo }).then((r) => {
      results.push('op2');
      return r;
    });

    const [result1, result2] = await Promise.all([operation1, operation2]);

    expect(result1.exitCode).toBe(0);
    expect(result2.exitCode).toBe(0);
    expect(results.length).toBe(2);
  });

  it('should handle multiple concurrent operations without interleaving', async () => {
    const results: Array<{ op: number; result: string }> = [];

    const op1 = gitCommand(['rev-parse', '--git-dir'], { cwd: testRepo }).then((r) => {
      results.push({ op: 1, result: r.stdout });
    });

    const op2 = gitCommand(['rev-parse', '--git-dir'], { cwd: testRepo }).then((r) => {
      results.push({ op: 2, result: r.stdout });
    });

    const op3 = gitCommand(['rev-parse', '--git-dir'], { cwd: testRepo }).then((r) => {
      results.push({ op: 3, result: r.stdout });
    });

    await Promise.all([op1, op2, op3]);

    expect(results.length).toBe(3);
    expect(results.every((r) => r.result === '.git')).toBe(true);
  });

  it('should trim stdout and stderr', async () => {
    const result = await gitCommand(['status'], { cwd: testRepo });
    expect(result.stdout).not.toMatch(/^\s/);
    expect(result.stdout).not.toMatch(/\s$/);
  });

  it('should return stdout untouched when asked for raw output', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(testRepo, 'new.txt'), 'x');

    const raw = await gitCommand(['status', '--porcelain', '-z'], { cwd: testRepo, raw: true });
    const trimmed = await gitCommand(['status', '--porcelain'], { cwd: testRepo });

    // NUL-terminated, nothing stripped: column-aligned statuses such as
    // " M file" keep their leading space.
    expect(raw.stdout).toBe('?? new.txt\0');
    expect(trimmed.stdout).toBe('?? new.txt');
  });

  it('should run with terminal prompts disabled', async () => {
    // The server has no terminal. A credential prompt would block the command
    // and, behind the mutex, every other git operation of every project.
    const result = await gitCommand(
      ['-c', 'alias.show-prompt-setting=!echo $GIT_TERMINAL_PROMPT', 'show-prompt-setting'],
      { cwd: testRepo },
    );

    expect(result.stdout).toBe('0');
  });

  it('should work with cwd option', async () => {
    const result = await gitCommand(['rev-parse', '--show-toplevel'], { cwd: testRepo });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.endsWith(testRepo.split('/').pop()!)).toBe(true);
  });
});
