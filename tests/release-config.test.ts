import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { generateNotes } from '@semantic-release/release-notes-generator';

// Runs the release tooling this repository actually installs, with the options
// from .releaserc.json. A preset that does not read `!` as a breaking change
// (the default one does not) publishes a breaking release as a minor one, or
// publishes nothing at all; a preset the installed writer cannot render fails
// the release. Neither shows up anywhere else before the release runs.

type PluginEntry = string | [string, Record<string, unknown>];

function pluginOptions(name: string): Record<string, unknown> {
  const config = JSON.parse(readFileSync(join(import.meta.dir, '..', '.releaserc.json'), 'utf8')) as {
    plugins: PluginEntry[];
  };
  const entry = config.plugins.find((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name);
  if (!entry) {
    throw new Error(`${name} is not configured in .releaserc.json`);
  }
  return Array.isArray(entry) ? entry[1] : {};
}

const logger = { log() {} };
const context = { cwd: join(import.meta.dir, '..'), logger };

function releaseType(message: string): Promise<string | null> {
  return analyzeCommits(pluginOptions('@semantic-release/commit-analyzer'), {
    ...context,
    commits: [{ hash: 'abc1234', message }],
  });
}

describe('release configuration', () => {
  it('reads "!" in the commit header as a breaking change: a major release', async () => {
    expect(await releaseType('feat!: run jobs as native OpenCode sessions')).toBe('major');
    expect(await releaseType('feat(core)!: run jobs as native OpenCode sessions')).toBe('major');
    expect(await releaseType('fix!: drop the tmux backend')).toBe('major');
  });

  it('reads a BREAKING CHANGE footer as a major release', async () => {
    expect(
      await releaseType('feat: run jobs as native OpenCode sessions\n\nBREAKING CHANGE: OpenCode V1 is no longer supported.'),
    ).toBe('major');
  });

  it('keeps the usual release types for everything else', async () => {
    expect(await releaseType('feat: add a dashboard')).toBe('minor');
    expect(await releaseType('fix: handle a deleted session')).toBe('patch');
    expect(await releaseType('perf: cache the project id')).toBe('patch');
    expect(await releaseType('chore: tidy')).toBeNull();
    expect(await releaseType('docs: describe permissions')).toBeNull();
  });

  it('renders release notes with the breaking change called out', async () => {
    const notes = await generateNotes(pluginOptions('@semantic-release/release-notes-generator'), {
      ...context,
      options: { repositoryUrl: 'https://github.com/nigel-dev/opencode-mission-control' },
      lastRelease: { gitTag: 'v1.6.0' },
      nextRelease: { gitTag: 'v2.0.0', version: '2.0.0' },
      commits: [
        {
          hash: 'abc1234abc1234',
          message:
            'feat!: run jobs as native OpenCode sessions\n\nBREAKING CHANGE: OpenCode V1 is no longer supported.',
          committerDate: '2026-11-16T00:00:00.000Z',
        },
      ],
    });

    expect(notes).toContain('2.0.0');
    expect(notes).toContain('BREAKING CHANGES');
    expect(notes).toContain('OpenCode V1 is no longer supported.');
    expect(notes).toContain('run jobs as native OpenCode sessions');
  });
});
