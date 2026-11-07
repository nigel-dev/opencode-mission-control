import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

export interface OMOStatus {
  detected: boolean;
  configSource: 'local' | 'global' | null;
  sisyphusPath: string | null;
}

/**
 * Detect if Oh-My-OpenCode (OMO) is installed by checking opencode.json
 * Checks both local (./opencode.json) and global (~/.config/opencode/opencode.json)
 * for "oh-my-opencode" in the plugin array
 */
export async function detectOMO(
  localPath: string = './opencode.json',
  globalPath: string = join(homedir(), '.config', 'opencode', 'opencode.json'),
): Promise<OMOStatus> {
  const basePath = '.';

  // Check local config first
  const localStatus = await checkConfigFile(localPath);
  if (localStatus.detected) {
    return {
      detected: true,
      configSource: 'local',
      sisyphusPath: await getSisyphusPath(basePath),
    };
  }

  // Check global config
  const globalStatus = await checkConfigFile(globalPath);
  if (globalStatus.detected) {
    return {
      detected: true,
      configSource: 'global',
      sisyphusPath: await getSisyphusPath(basePath),
    };
  }

  return {
    detected: false,
    configSource: null,
    sisyphusPath: null,
  };
}

/**
 * Check if a config file contains "oh-my-opencode" in the plugin array.
 * Supports both the V2 `plugins` key and the legacy V1 `plugin` key.
 * V2 entries may be strings ("pkg", "-pkg" to disable) or objects ({ package, options }).
 */
async function checkConfigFile(filePath: string): Promise<{ detected: boolean }> {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      return { detected: false };
    }

    const content = await file.text();
    const config = JSON.parse(content);

    return { detected: hasOMOPlugin(config.plugins) || hasOMOPlugin(config.plugin) };
  } catch {
    // File doesn't exist or is invalid JSON
    return { detected: false };
  }
}

function hasOMOPlugin(entries: unknown): boolean {
  if (!Array.isArray(entries)) {
    return false;
  }

  return entries.some((entry) => {
    if (typeof entry === 'string') {
      // A leading "-" disables a plugin in V2 config.
      if (entry.startsWith('-')) {
        return false;
      }
      return entry === 'oh-my-opencode' || entry.startsWith('oh-my-opencode@');
    }

    if (entry && typeof entry === 'object' && 'package' in entry) {
      const pkg = (entry as { package?: unknown }).package;
      return typeof pkg === 'string' && (pkg === 'oh-my-opencode' || pkg.startsWith('oh-my-opencode@'));
    }

    return false;
  });
}

/**
 * Get the .sisyphus path if it exists in the current directory
 */
async function getSisyphusPath(basePath: string = '.'): Promise<string | null> {
  try {
    const sisyphusPath = join(basePath, '.sisyphus');
    const exists = existsSync(sisyphusPath);
    // Return relative path without leading ./
    return exists ? '.sisyphus' : null;
  } catch {
    return null;
  }
}
