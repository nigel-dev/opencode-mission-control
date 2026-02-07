import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  type MCConfig,
} from '../../src/lib/config';

let testConfigDir: string;

function getTestConfigFile(): string {
  return join(testConfigDir, 'config.json');
}

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-config-test-'));
}

describe('config', () => {
  beforeEach(async () => {
    testConfigDir = await createTempDir();
    vi.spyOn(paths, 'getDataDir').mockResolvedValue(testConfigDir);
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

      expect(config.defaultPlacement).toBe('session');
      expect(config.pollInterval).toBe(10000);
      expect(config.idleThreshold).toBe(300000);
      expect(config.worktreeBasePath).toBe(
        join(homedir(), '.local', 'share', 'opencode-mission-control')
      );
      expect(config.omo.enabled).toBe(false);
      expect(config.omo.defaultMode).toBe('vanilla');
    });

    it('should load existing config from file', async () => {
      const testConfig: MCConfig = {
        defaultPlacement: 'window',
        pollInterval: 5000,
        idleThreshold: 600000,
        worktreeBasePath: '/custom/path',
        omo: {
          enabled: true,
          defaultMode: 'plan',
        },
      };

      await Bun.write(getTestConfigFile(), JSON.stringify(testConfig));
      const loaded = await loadConfig();

      expect(loaded.defaultPlacement).toBe('window');
      expect(loaded.pollInterval).toBe(5000);
      expect(loaded.idleThreshold).toBe(600000);
      expect(loaded.worktreeBasePath).toBe('/custom/path');
      expect(loaded.omo.enabled).toBe(true);
      expect(loaded.omo.defaultMode).toBe('plan');
    });

    it('should merge file config with defaults', async () => {
      const partialConfig = {
        pollInterval: 15000,
        omo: {
          enabled: true,
        },
      };

      await Bun.write(getTestConfigFile(), JSON.stringify(partialConfig));
      const loaded = await loadConfig();

      expect(loaded.pollInterval).toBe(15000);
      expect(loaded.omo.enabled).toBe(true);
      expect(loaded.omo.defaultMode).toBe('vanilla');
      expect(loaded.defaultPlacement).toBe('session');
      expect(loaded.idleThreshold).toBe(300000);
    });

    it('should throw error on invalid JSON', async () => {
      await Bun.write(getTestConfigFile(), 'invalid json {');

      await expect(loadConfig()).rejects.toThrow('Failed to load config');
    });
  });

  describe('saveConfig', () => {
    it('should save config to file', async () => {
      const config: MCConfig = {
        defaultPlacement: 'window',
        pollInterval: 20000,
        idleThreshold: 400000,
        worktreeBasePath: '/another/path',
        omo: {
          enabled: true,
          defaultMode: 'ralph',
        },
      };

      await saveConfig(config);
      const file = Bun.file(getTestConfigFile());
      expect(await file.exists()).toBe(true);

      const content = await file.text();
      const loaded = JSON.parse(content) as MCConfig;

      expect(loaded.defaultPlacement).toBe('window');
      expect(loaded.pollInterval).toBe(20000);
      expect(loaded.idleThreshold).toBe(400000);
      expect(loaded.worktreeBasePath).toBe('/another/path');
      expect(loaded.omo.enabled).toBe(true);
      expect(loaded.omo.defaultMode).toBe('ralph');
    });

    it('should use atomic write pattern', async () => {
      const config: MCConfig = {
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: join(homedir(), '.local', 'share', 'opencode-mission-control'),
        omo: {
          enabled: false,
          defaultMode: 'vanilla',
        },
      };

      await saveConfig(config);
      const file = Bun.file(getTestConfigFile());
      expect(await file.exists()).toBe(true);

      const tempFile = Bun.file(`${getTestConfigFile()}.tmp`);
      expect(await tempFile.exists()).toBe(false);
    });

    it('should format JSON with indentation', async () => {
      const config: MCConfig = {
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/path',
        omo: {
          enabled: false,
          defaultMode: 'vanilla',
        },
      };

      await saveConfig(config);
      const file = Bun.file(getTestConfigFile());
      const content = await file.text();

      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });
  });

  describe('loadConfig and saveConfig integration', () => {
    it('should round-trip config correctly', async () => {
      const originalConfig: MCConfig = {
        defaultPlacement: 'window',
        pollInterval: 25000,
        idleThreshold: 500000,
        worktreeBasePath: '/integration/test/path',
        maxParallel: 3,
        autoCommit: true,
        testTimeout: 600000,
        mergeStrategy: 'squash',
        omo: {
          enabled: true,
          defaultMode: 'ulw',
        },
      };

      await saveConfig(originalConfig);
      const loaded = await loadConfig();

      expect(loaded).toEqual(originalConfig);
    });

    it('should update config on subsequent saves', async () => {
      const config1: MCConfig = {
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/path1',
        omo: {
          enabled: false,
          defaultMode: 'vanilla',
        },
      };

      await saveConfig(config1);
      let loaded = await loadConfig();
      expect(loaded.worktreeBasePath).toBe('/path1');

      const config2: MCConfig = {
        ...config1,
        worktreeBasePath: '/path2',
      };

      await saveConfig(config2);
      loaded = await loadConfig();
      expect(loaded.worktreeBasePath).toBe('/path2');
    });
  });
});
