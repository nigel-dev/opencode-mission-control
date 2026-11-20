import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { getDataDir } from './paths';
import { MCConfigSchema, PartialMCConfigSchema } from './schemas';
import { PermissionPolicy } from './permission-policy';
import { atomicWrite } from './utils';

export type WorktreeSetup = {
  copyFiles?: string[];
  symlinkDirs?: string[];
  commands?: string[];
};

export type MCConfig = z.infer<typeof MCConfigSchema>;

const DEFAULT_CONFIG: MCConfig = {
  pollInterval: 10000,
  worktreeBasePath: join(homedir(), '.local', 'share', 'opencode-mission-control'),
  maxParallel: 3,
  autoCommit: true,
  testTimeout: 600000,
  mergeStrategy: 'squash',
  fixBeforeRollbackTimeout: 120000,
  defaultPermissionPolicy: PermissionPolicy.getDefaultPolicy(),
};

const CONFIG_FILE = 'config.json';

export async function getConfigPath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, CONFIG_FILE);
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
    // Keys removed in 2.0 are stripped by the schema instead of failing the load.
    const fileConfig = PartialMCConfigSchema.parse(JSON.parse(content));
    const result: MCConfig = {
      ...DEFAULT_CONFIG,
      ...fileConfig,
    };
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid config in ${filePath}: ${error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
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
