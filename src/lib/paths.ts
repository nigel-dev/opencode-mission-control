import { homedir } from 'os';
import { basename, join } from 'path';
import { gitCommand } from './git';

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
  const result = await gitCommand(['rev-parse', '--show-toplevel'], { cwd });

  if (result.exitCode !== 0) {
    return basename(cwd ?? process.cwd());
  }

  return basename(result.stdout);
}

export async function getDataDir(cwd?: string): Promise<string> {
  const projectId = await getProjectId(cwd);
  const dir = join(XDG_DATA_DIR, projectId, 'state');
  const fs = await import('fs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
