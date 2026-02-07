import { join } from 'path';
import { homedir } from 'os';

export interface MCConfig {
  defaultPlacement: 'session' | 'window';
  pollInterval: number;
  idleThreshold: number;
  worktreeBasePath: string;
  omo: {
    enabled: boolean;
    defaultMode: 'vanilla' | 'plan' | 'ralph' | 'ulw';
  };
}

const DEFAULT_CONFIG: MCConfig = {
  defaultPlacement: 'session',
  pollInterval: 10000,
  idleThreshold: 300000,
  worktreeBasePath: join(homedir(), '.local', 'share', 'opencode-mission-control'),
  omo: {
    enabled: false,
    defaultMode: 'vanilla',
  },
};

const CONFIG_FILE_PATH = '.mission-control/config.json';

export function getConfigPath(): string {
  return join(process.cwd(), CONFIG_FILE_PATH);
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await Bun.write(tempPath, data);
  // Use fs.renameSync for atomic rename operation
  const fs = await import('fs');
  fs.renameSync(tempPath, filePath);
}

export async function loadConfig(): Promise<MCConfig> {
  const filePath = getConfigPath();
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = await file.text();
    const fileConfig = JSON.parse(content) as Partial<MCConfig>;
    // Merge file config with defaults
    return {
      ...DEFAULT_CONFIG,
      ...fileConfig,
      omo: {
        ...DEFAULT_CONFIG.omo,
        ...(fileConfig.omo || {}),
      },
    };
  } catch (error) {
    throw new Error(`Failed to load config from ${filePath}: ${error}`);
  }
}

export async function saveConfig(config: MCConfig): Promise<void> {
  const filePath = getConfigPath();

  try {
    const data = JSON.stringify(config, null, 2);
    await atomicWrite(filePath, data);
  } catch (error) {
    throw new Error(`Failed to save config to ${filePath}: ${error}`);
  }
}
