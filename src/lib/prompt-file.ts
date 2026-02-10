import { join } from 'path';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { spawnSync } from 'bun';

const PROMPT_FILENAME = '.mc-prompt.txt';
const LAUNCHER_FILENAME = '.mc-launch.sh';

function resolveOpencodePath(): string {
  const result = spawnSync(['which', 'opencode'], { stderr: 'pipe' });
  if (result.exitCode === 0) {
    const resolved = result.stdout.toString().trim();
    if (resolved) return resolved;
  }
  return 'opencode';
}

export async function writePromptFile(
  worktreePath: string,
  prompt: string,
): Promise<string> {
  const filePath = join(worktreePath, PROMPT_FILENAME);
  await mkdir(worktreePath, { recursive: true });
  await writeFile(filePath, prompt, 'utf-8');
  return filePath;
}

export function cleanupPromptFile(filePath: string, delayMs = 5000): void {
  setTimeout(() => {
    unlink(filePath).catch(() => {});
  }, delayMs);
}

export async function writeLauncherScript(
  worktreePath: string,
  promptFilePath: string,
  model?: string,
): Promise<string> {
  const launcherPath = join(worktreePath, LAUNCHER_FILENAME);
  const opencodeBin = resolveOpencodePath();
  const modelFlag = model ? ` -m "${model}"` : '';
  const script = `#!/bin/bash\nexec ${opencodeBin}${modelFlag} --prompt "$(cat '${promptFilePath}')"\n`;
  await writeFile(launcherPath, script, { mode: 0o755 });
  return launcherPath;
}

export function cleanupLauncherScript(worktreePath: string, delayMs = 5000): void {
  const launcherPath = join(worktreePath, LAUNCHER_FILENAME);
  setTimeout(() => {
    unlink(launcherPath).catch(() => {});
  }, delayMs);
}
