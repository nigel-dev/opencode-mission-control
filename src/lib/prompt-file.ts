import { join } from 'path';
import { writeFile, unlink, mkdir } from 'fs/promises';

const PROMPT_FILENAME = '.mc-prompt.txt';

/**
 * Write prompt to a temp file in the worktree, avoiding shell injection
 * by keeping user content out of shell interpolation entirely.
 */
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

/**
 * SECURITY: The $(cat ...) expansion only contains a controlled file path — never user input.
 */
export function buildPromptFileCommand(promptFilePath: string): string {
  return `opencode --prompt "$(cat '${promptFilePath}')"`;
}
