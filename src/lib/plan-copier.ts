/**
 * Copy .sisyphus/plans/ directory to worktree
 * Excludes state.json and boulder.json
 * @param sourcePath - Main worktree .sisyphus/plans/ directory
 * @param targetPath - Job worktree .sisyphus/plans/ directory
 * @returns List of copied plan files
 */
export async function copyPlansToWorktree(
  sourcePath: string,
  targetPath: string,
): Promise<{ copied: string[] }> {
  const fs = await import('fs').then((m) => m.promises);
  const path = await import('path');

  const copied: string[] = [];

  try {
    // Create target directory if it doesn't exist
    await fs.mkdir(targetPath, { recursive: true });

    // Read source directory
    const files = await fs.readdir(sourcePath, { withFileTypes: true });

    for (const file of files) {
      // Skip state.json and boulder.json
      if (file.name === 'state.json' || file.name === 'boulder.json') {
        continue;
      }

      const sourceFull = path.join(sourcePath, file.name);
      const targetFull = path.join(targetPath, file.name);

      if (file.isFile()) {
        // Copy file
        await fs.copyFile(sourceFull, targetFull);
        copied.push(file.name);
      } else if (file.isDirectory()) {
        // Recursively copy directory
        await copyDirectory(sourceFull, targetFull);
        // Add all files from this directory to copied list
        const dirFiles = await getAllFilesInDirectory(sourceFull, sourcePath);
        copied.push(...dirFiles);
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('ENOENT') &&
      error.message.includes(sourcePath)
    ) {
      // Source directory doesn't exist - return empty list
      return { copied: [] };
    }
    throw error;
  }

  return { copied };
}

/**
 * Recursively copy a directory
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  const fs = await import('fs').then((m) => m.promises);
  const path = await import('path');

  await fs.mkdir(dest, { recursive: true });

  const files = await fs.readdir(src, { withFileTypes: true });

  for (const file of files) {
    const srcPath = path.join(src, file.name);
    const destPath = path.join(dest, file.name);

    if (file.isFile()) {
      await fs.copyFile(srcPath, destPath);
    } else if (file.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    }
  }
}

/**
 * Get all files in a directory recursively
 */
async function getAllFilesInDirectory(
  dir: string,
  baseDir?: string,
): Promise<string[]> {
  const fs = await import('fs').then((m) => m.promises);
  const path = await import('path');

  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const base = baseDir || dir;

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(base, fullPath);

    if (entry.isFile()) {
      files.push(relativePath);
    } else if (entry.isDirectory()) {
      const subFiles = await getAllFilesInDirectory(fullPath, base);
      files.push(...subFiles);
    }
  }

  return files;
}
