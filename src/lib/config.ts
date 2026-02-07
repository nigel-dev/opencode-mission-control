import { join } from 'path';
import { homedir } from 'os';
import { getDataDir } from './paths';

export interface WorktreeSetup {
  copyFiles?: string[];
  symlinkDirs?: string[];
  commands?: string[];
}

export interface MCConfig {
  defaultPlacement: 'session' | 'window';
  pollInterval: number;
  idleThreshold: number;
  worktreeBasePath: string;
  maxParallel?: number;
  testCommand?: string;
  testTimeout?: number;
  worktreeSetup?: WorktreeSetup;
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
  maxParallel: 3,
  testTimeout: 600000,
  omo: {
    enabled: false,
    defaultMode: 'vanilla',
  },
};

const CONFIG_FILE = 'config.json';

export async function getConfigPath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, CONFIG_FILE);
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await Bun.write(tempPath, data);
  // Use fs.renameSync for atomic rename operation
  const fs = await import('fs');
  fs.renameSync(tempPath, filePath);
}

export async function loadConfig(): Promise<MCConfig> {
  const filePath = await getConfigPath();
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = await file.text();
    const fileConfig = JSON.parse(content) as Partial<MCConfig>;
    const result: MCConfig = {
      ...DEFAULT_CONFIG,
      ...fileConfig,
      omo: {
        ...DEFAULT_CONFIG.omo,
        ...(fileConfig.omo || {}),
      },
    };
    return result;
  } catch (error) {
    throw new Error(`Failed to load config from ${filePath}: ${error}`);
  }
}

export async function saveConfig(config: MCConfig): Promise<void> {
  const filePath = await getConfigPath();

  try {
    const configToSave = Object.fromEntries(
      Object.entries(config).filter(([, value]) => value !== undefined)
    ) as MCConfig;
    const data = JSON.stringify(configToSave, null, 2);
    await atomicWrite(filePath, data);
  } catch (error) {
    throw new Error(`Failed to save config to ${filePath}: ${error}`);
  }
}
