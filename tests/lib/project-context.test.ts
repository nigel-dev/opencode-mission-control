import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'bun';
import {
  bindToProject,
  getProjectDirectory,
  registerProject,
  runInProject,
} from '../../src/lib/project-context';
import { gitCommand } from '../../src/lib/git';
import { getProjectId } from '../../src/lib/paths';
import {
  disposeSharedState,
  getSharedMonitor,
  getSharedNotifyCallback,
  setSharedNotifyCallback,
} from '../../src/lib/orchestrator-singleton';
import { setToastEmitter, showToast } from '../../src/lib/toast';

function initRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  const result = spawnSync(['git', 'init', '-q'], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git init failed: ${result.stderr.toString()}`);
  }
  return dir;
}

describe('project context', () => {
  let root: string;
  let repoA: string;
  let repoB: string;
  let notARepo: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-project-context-')));
    repoA = initRepo(root, 'project-a');
    repoB = initRepo(root, 'project-b');
    notARepo = join(root, 'server-cwd');
    mkdirSync(notARepo);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to the process cwd outside a context', () => {
    expect(getProjectDirectory()).toBe(process.cwd());
  });

  it('falls back to the only registered project when the context is lost', () => {
    const unregisterA = runInProject(repoA, () => registerProject());
    expect(getProjectDirectory()).toBe(repoA);

    // With two projects loaded there is no safe guess. The server's own
    // working directory is no project at all, so this fails loudly instead of
    // quietly reading or changing the wrong project's state.
    const unregisterB = runInProject(repoB, () => registerProject());
    expect(() => getProjectDirectory()).toThrow('lost track of which project');
    expect(runInProject(repoB, () => getProjectDirectory())).toBe(repoB);

    unregisterB();
    expect(getProjectDirectory()).toBe(repoA);
    unregisterA();
    expect(getProjectDirectory()).toBe(process.cwd());
  });

  it('exposes the directory inside a context, across awaits and timers', async () => {
    await runInProject(repoA, async () => {
      expect(getProjectDirectory()).toBe(repoA);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(getProjectDirectory()).toBe(repoA);
      const fromTimer = await new Promise<string>((resolve) => {
        setTimeout(() => resolve(getProjectDirectory()), 5);
      });
      expect(fromTimer).toBe(repoA);
    });
    expect(getProjectDirectory()).toBe(process.cwd());
  });

  it('bindToProject re-enters the project when called from another context', async () => {
    const bound = runInProject(repoA, () => bindToProject(async () => getProjectDirectory()));

    expect(await bound()).toBe(repoA);
    expect(await runInProject(repoB, () => bound())).toBe(repoA);
  });

  it('runs git in the project directory, not the process cwd', async () => {
    const outside = await gitCommand(['rev-parse', '--show-toplevel'], { cwd: notARepo });
    expect(outside.exitCode).not.toBe(0);

    const inside = await runInProject(repoA, () => gitCommand(['rev-parse', '--show-toplevel']));
    expect(inside.exitCode).toBe(0);
    expect(inside.stdout).toBe(repoA);
  });

  it('resolves the project id from the context directory', async () => {
    expect(await runInProject(repoA, () => getProjectId())).toBe(basename(repoA));
    expect(await runInProject(repoB, () => getProjectId())).toBe(basename(repoB));
  });

  it('keeps concurrent projects apart while git commands queue on the mutex', async () => {
    const run = (dir: string) =>
      runInProject(dir, () =>
        Promise.all(
          Array.from({ length: 5 }, () => gitCommand(['rev-parse', '--show-toplevel'])),
        ),
      );

    const [a, b] = await Promise.all([run(repoA), run(repoB)]);

    expect(a.map((r) => r.stdout)).toEqual(Array(5).fill(repoA));
    expect(b.map((r) => r.stdout)).toEqual(Array(5).fill(repoB));
  });

  it('keeps shared monitors and notify callbacks per project', () => {
    const notifyA = () => {};
    const monitorA = runInProject(repoA, () => {
      setSharedNotifyCallback(notifyA);
      return getSharedMonitor();
    });
    const monitorB = runInProject(repoB, () => getSharedMonitor());

    expect(monitorA).not.toBe(monitorB);
    expect(runInProject(repoA, () => getSharedMonitor())).toBe(monitorA);
    expect(runInProject(repoA, () => getSharedNotifyCallback())).toBe(notifyA);
    expect(runInProject(repoB, () => getSharedNotifyCallback())).toBeNull();

    runInProject(repoA, () => disposeSharedState());

    expect(runInProject(repoA, () => getSharedMonitor())).not.toBe(monitorA);
    expect(runInProject(repoA, () => getSharedNotifyCallback())).toBeNull();
    expect(runInProject(repoB, () => getSharedMonitor())).toBe(monitorB);

    runInProject(repoA, () => disposeSharedState());
    runInProject(repoB, () => disposeSharedState());
  });

  it('routes toasts to the emitter of the current project', async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    runInProject(repoA, () => setToastEmitter(async (o) => { seenA.push(o.message); }));
    runInProject(repoB, () => setToastEmitter(async (o) => { seenB.push(o.message); }));

    await runInProject(repoA, () => showToast({ message: 'from a' }));
    await runInProject(repoB, () => showToast({ message: 'from b' }));

    expect(seenA).toEqual(['from a']);
    expect(seenB).toEqual(['from b']);

    runInProject(repoA, () => setToastEmitter(null));
    runInProject(repoB, () => setToastEmitter(null));
  });
});
