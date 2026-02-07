import { spawn } from 'bun';
import { homedir } from 'os';
import { basename, join } from 'path';

const XDG_DATA_DIR = join(
  homedir(),
  '.local',
  'share',
  'opencode-mission-control',
);

export function getXdgDataDir(): string {
  return XDG_DATA_DIR;
}

export async function getProjectId(cwd?: string): Promise<string> {
  const proc = spawn(['git', 'rev-parse', '--show-toplevel'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return basename(cwd ?? process.cwd());
  }

  return basename(stdout.trim());
}

export async function getDataDir(cwd?: string): Promise<string> {
  const projectId = await getProjectId(cwd);
  const dir = join(XDG_DATA_DIR, projectId, 'state');
  const fs = await import('fs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
