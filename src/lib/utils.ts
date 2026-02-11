/**
 * Shared utility functions used across the codebase
 */

/**
 * Atomically write data to a file using a temporary file and rename.
 * Ensures data integrity by writing to a temp file first, then renaming atomically.
 */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await Bun.write(tempPath, data);
  // Use fs.renameSync for atomic rename operation
  const fs = await import('fs');
  fs.renameSync(tempPath, filePath);
}

/**
 * Extract conflicting files from git stderr output.
 * Returns array of conflicting file paths, or fallback to stderr if no CONFLICT patterns found.
 */
export function extractConflicts(stderr: string): string[] {
  const conflicts: string[] = [];
  const lines = stderr.split('\n');

  for (const line of lines) {
    const conflictMatch = line.match(/CONFLICT \(.*?\): (?:Merge conflict in )?(.+)/);
    if (conflictMatch) {
      conflicts.push(conflictMatch[1]);
    }
  }

  if (conflicts.length > 0) {
    return conflicts;
  }

  const fallback = stderr.trim();
  return fallback ? [fallback] : [];
}

/**
 * Format elapsed time from a start date to now.
 * Returns format like "1h 30m 45s"
 */
export function formatElapsed(createdAt: string): string {
  const start = Date.parse(createdAt);
  if (Number.isNaN(start)) {
    return 'unknown duration';
  }

  const totalSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Format time difference between two dates as "X ago" format.
 * Returns format like "1h ago", "30m ago", etc.
 */
export function formatTimeAgo(startDate: string, endDate?: string): string {
  const start = new Date(startDate);
  const end = endDate ? new Date(endDate) : new Date();
  const diffMs = end.getTime() - start.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

/**
 * Format duration in milliseconds to human-readable string.
 * Returns format like "1h 30m", "45m", etc.
 */
export function formatDurationMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
