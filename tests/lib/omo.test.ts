import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectOMO } from '../../src/lib/omo';
import { mkdirSync, rmSync } from 'fs';

describe('OMO Detector', () => {
  const originalCwd = process.cwd();
  const testDir = '/tmp/omo-test';

  beforeEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should detect OMO when local opencode.json has oh-my-opencode plugin', async () => {
    const config = {
      plugin: ['oh-my-opencode', 'opencode-mission-control'],
    };
    await Bun.write('./opencode.json', JSON.stringify(config));

    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.detected).toBe(true);
    expect(status.configSource).toBe('local');
  });

  it('should not detect OMO when local opencode.json lacks oh-my-opencode', async () => {
    const config = {
      plugin: ['opencode-mission-control'],
    };
    await Bun.write('./opencode.json', JSON.stringify(config));

    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
  });

  it('should not detect OMO when opencode.json does not exist', async () => {
    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
  });

  it('should not detect OMO when opencode.json has no plugin array', async () => {
    const config = {
      name: 'test',
    };
    await Bun.write('./opencode.json', JSON.stringify(config));

    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
  });

  it('should not detect OMO when opencode.json is invalid JSON', async () => {
    await Bun.write('./opencode.json', 'invalid json {');

    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
  });

  it('should return null sisyphusPath when .sisyphus does not exist', async () => {
    const config = {
      plugin: ['oh-my-opencode'],
    };
    await Bun.write('./opencode.json', JSON.stringify(config));

    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.sisyphusPath).toBeNull();
  });

  it('should return sisyphusPath when .sisyphus exists', async () => {
    const config = {
      plugin: ['oh-my-opencode'],
    };
    await Bun.write('./opencode.json', JSON.stringify(config));
    mkdirSync('./.sisyphus', { recursive: true });

    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.sisyphusPath).toBe('.sisyphus');
  });

  it('should prefer local config over global config', async () => {
    const config = {
      plugin: ['oh-my-opencode'],
    };
    await Bun.write('./opencode.json', JSON.stringify(config));

    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.configSource).toBe('local');
  });

  it('should handle empty plugin array', async () => {
    const config = {
      plugin: [],
    };
    await Bun.write('./opencode.json', JSON.stringify(config));

    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.detected).toBe(false);
  });

  it('should handle plugin array with multiple entries', async () => {
    const config = {
      plugin: ['plugin-a', 'oh-my-opencode', 'plugin-b'],
    };
    await Bun.write('./opencode.json', JSON.stringify(config));

    const status = await detectOMO('./opencode.json', '/nonexistent/global.json');

    expect(status.detected).toBe(true);
    expect(status.configSource).toBe('local');
  });
});
