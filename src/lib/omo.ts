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
 * Check if a config file contains "oh-my-opencode" in the plugin array
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

    if (!config.plugin || !Array.isArray(config.plugin)) {
      return { detected: false };
    }

    const hasOMO = config.plugin.includes('oh-my-opencode');
    return { detected: hasOMO };
  } catch {
    // File doesn't exist or is invalid JSON
    return { detected: false };
  }
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
