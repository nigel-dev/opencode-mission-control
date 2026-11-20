import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';
import type { MCConfig } from '../../src/lib/config';
import { PermissionPolicy } from '../../src/lib/permission-policy';

vi.mock('../../src/lib/paths', () => ({
  getDataDir: vi.fn(),
}));

const paths = await import('../../src/lib/paths');
const { loadConfig, saveConfig, getConfigPath } = await import('../../src/lib/config');
const { PartialMCConfigSchema } = await import('../../src/lib/schemas');

let testConfigDir: string;

function getTestConfigFile(): string {
  return join(testConfigDir, 'config.json');
}

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-config-test-'));
}

/** A config.json as written by a 1.x release, with every since-removed key. */
const LEGACY_CONFIG = {
  defaultPlacement: 'window',
  pollInterval: 15000,
  idleThreshold: 600000,
  worktreeBasePath: '/legacy/path',
  maxParallel: 5,
  autoCommit: false,
  testCommand: 'bun test',
  testTimeout: 300000,
  mergeStrategy: 'merge',
  worktreeSetup: { copyFiles: ['.env'], commands: ['bun install'] },
  useServeMode: true,
  portRangeStart: 14100,
  portRangeEnd: 14199,
  serverPassword: 'hunter2',
  fixBeforeRollbackTimeout: 60000,
  omo: { enabled: true, defaultMode: 'ralph' },
};

const REMOVED_KEYS = [
  'defaultPlacement',
  'idleThreshold',
  'useServeMode',
  'portRangeStart',
  'portRangeEnd',
  'serverPassword',
  'omo',
];

describe('config', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    testConfigDir = await createTempDir();
    (paths.getDataDir as unknown as { mockResolvedValue(value: string): void }).mockResolvedValue(testConfigDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const fs = await import('fs');
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    }
  });

  describe('getConfigPath', () => {
    it('should return config file path', async () => {
      const path = await getConfigPath();
      expect(path).toBe(getTestConfigFile());
    });
  });

  describe('loadConfig', () => {
    it('should return default config when file does not exist', async () => {
      const config = await loadConfig();

      expect(config).toEqual({
        pollInterval: 10000,
        worktreeBasePath: join(homedir(), '.local', 'share', 'opencode-mission-control'),
        maxParallel: 3,
        autoCommit: true,
        testTimeout: 600000,
        mergeStrategy: 'squash',
        fixBeforeRollbackTimeout: 120000,
        defaultPermissionPolicy: PermissionPolicy.getDefaultPolicy(),
      });
    });

    it('should not define a default agent or model', async () => {
      const config = await loadConfig();

      expect(config.defaultAgent).toBeUndefined();
      expect(config.defaultModel).toBeUndefined();
    });

    it('should load existing config from file', async () => {
      const testConfig: MCConfig = {
        pollInterval: 5000,
        worktreeBasePath: '/custom/path',
        defaultAgent: 'build',
        defaultModel: 'anthropic/claude-sonnet-4#high',
      };

      await Bun.write(getTestConfigFile(), JSON.stringify(testConfig));
      const loaded = await loadConfig();

      expect(loaded.pollInterval).toBe(5000);
      expect(loaded.worktreeBasePath).toBe('/custom/path');
      expect(loaded.defaultAgent).toBe('build');
      expect(loaded.defaultModel).toBe('anthropic/claude-sonnet-4#high');
    });

    it('should merge file config with defaults', async () => {
      await Bun.write(getTestConfigFile(), JSON.stringify({ pollInterval: 15000 }));
      const loaded = await loadConfig();

      expect(loaded.pollInterval).toBe(15000);
      expect(loaded.maxParallel).toBe(3);
      expect(loaded.mergeStrategy).toBe('squash');
      expect(loaded.worktreeBasePath).toBe(
        join(homedir(), '.local', 'share', 'opencode-mission-control'),
      );
    });

    it('should throw error on invalid JSON', async () => {
      await Bun.write(getTestConfigFile(), 'invalid json {');

      await expect(loadConfig()).rejects.toThrow('Failed to load config');
    });

    it('should reject a value of the wrong type for a supported key', async () => {
      await Bun.write(getTestConfigFile(), JSON.stringify({ pollInterval: 'fast' }));

      await expect(loadConfig()).rejects.toThrow('Invalid config');
    });
  });

  describe('legacy config keys', () => {
    it('should load a 1.x config file without failing', async () => {
      await Bun.write(getTestConfigFile(), JSON.stringify(LEGACY_CONFIG));

      await expect(loadConfig()).resolves.toBeDefined();
    });

    it('should drop the removed keys and keep the supported ones', async () => {
      await Bun.write(getTestConfigFile(), JSON.stringify(LEGACY_CONFIG));

      const loaded = await loadConfig();

      for (const key of REMOVED_KEYS) {
        expect(loaded).not.toHaveProperty(key);
      }
      expect(loaded).toEqual({
        pollInterval: 15000,
        worktreeBasePath: '/legacy/path',
        maxParallel: 5,
        autoCommit: false,
        testCommand: 'bun test',
        testTimeout: 300000,
        mergeStrategy: 'merge',
        worktreeSetup: { copyFiles: ['.env'], commands: ['bun install'] },
        fixBeforeRollbackTimeout: 60000,
        defaultPermissionPolicy: PermissionPolicy.getDefaultPolicy(),
      });
    });

    it('should ignore removed keys even when their values are malformed', async () => {
      await Bun.write(
        getTestConfigFile(),
        JSON.stringify({
          pollInterval: 20000,
          defaultPlacement: 42,
          useServeMode: 'yes',
          portRangeStart: 'low',
          omo: 'enabled',
        }),
      );

      const loaded = await loadConfig();

      expect(loaded.pollInterval).toBe(20000);
      for (const key of REMOVED_KEYS) {
        expect(loaded).not.toHaveProperty(key);
      }
    });

    it('should ignore unknown keys in general', async () => {
      await Bun.write(
        getTestConfigFile(),
        JSON.stringify({ pollInterval: 20000, somethingFromTheFuture: { nested: true } }),
      );

      const loaded = await loadConfig();

      expect(loaded.pollInterval).toBe(20000);
      expect(loaded).not.toHaveProperty('somethingFromTheFuture');
    });

    it('should strip unknown keys at the schema level', () => {
      const parsed = PartialMCConfigSchema.parse(LEGACY_CONFIG);

      for (const key of REMOVED_KEYS) {
        expect(parsed).not.toHaveProperty(key);
      }
      expect(parsed.pollInterval).toBe(15000);
    });

    it('should not write removed keys back when a loaded legacy config is saved', async () => {
      await Bun.write(getTestConfigFile(), JSON.stringify(LEGACY_CONFIG));

      await saveConfig(await loadConfig());
      const saved = JSON.parse(await Bun.file(getTestConfigFile()).text());

      for (const key of REMOVED_KEYS) {
        expect(saved).not.toHaveProperty(key);
      }
      expect(saved.worktreeBasePath).toBe('/legacy/path');
    });
  });

  describe('saveConfig', () => {
    it('should save config to file', async () => {
      const config: MCConfig = {
        pollInterval: 20000,
        worktreeBasePath: '/another/path',
        defaultAgent: 'build',
        defaultModel: 'openai/gpt-5',
      };

      await saveConfig(config);
      const file = Bun.file(getTestConfigFile());
      expect(await file.exists()).toBe(true);

      const loaded = JSON.parse(await file.text()) as MCConfig;

      expect(loaded).toEqual(config);
    });

    it('should omit undefined values', async () => {
      await saveConfig({ pollInterval: 10000, worktreeBasePath: '/path', defaultModel: undefined });

      const saved = JSON.parse(await Bun.file(getTestConfigFile()).text());

      expect(saved).toEqual({ pollInterval: 10000, worktreeBasePath: '/path' });
    });

    it('should use atomic write pattern', async () => {
      await saveConfig({ pollInterval: 10000, worktreeBasePath: '/path' });

      expect(await Bun.file(getTestConfigFile()).exists()).toBe(true);
      expect(await Bun.file(`${getTestConfigFile()}.tmp`).exists()).toBe(false);
    });

    it('should format JSON with indentation', async () => {
      await saveConfig({ pollInterval: 10000, worktreeBasePath: '/path' });
      const content = await Bun.file(getTestConfigFile()).text();

      expect(content).toBe(
        JSON.stringify({ pollInterval: 10000, worktreeBasePath: '/path' }, null, 2),
      );
    });
  });

  describe('loadConfig and saveConfig integration', () => {
    it('should round-trip config correctly', async () => {
      const originalConfig: MCConfig = {
        pollInterval: 25000,
        worktreeBasePath: '/integration/test/path',
        maxParallel: 3,
        autoCommit: true,
        testTimeout: 600000,
        mergeStrategy: 'squash',
        fixBeforeRollbackTimeout: 120000,
        defaultAgent: 'build',
        defaultModel: 'anthropic/claude-sonnet-4',
      };

      await saveConfig(originalConfig);
      const loaded = await loadConfig();

      expect(loaded).toEqual({
        ...originalConfig,
        defaultPermissionPolicy: PermissionPolicy.getDefaultPolicy(),
      });
    });

    it('should update config on subsequent saves', async () => {
      const config1: MCConfig = { pollInterval: 10000, worktreeBasePath: '/path1' };

      await saveConfig(config1);
      let loaded = await loadConfig();
      expect(loaded.worktreeBasePath).toBe('/path1');

      await saveConfig({ ...config1, worktreeBasePath: '/path2' });
      loaded = await loadConfig();
      expect(loaded.worktreeBasePath).toBe('/path2');
    });
  });
});
