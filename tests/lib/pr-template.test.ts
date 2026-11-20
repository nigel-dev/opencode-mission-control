import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fillPrTemplate, loadPrTemplate } from '../../src/lib/pr-template';

const TEMPLATE = [
  '## Summary',
  '',
  'Brief description of the changes.',
  '',
  '## Changes',
  '',
  '- ',
  '',
  '## Testing',
  '',
  '- [ ] `bun test` passes',
  '',
  '## Checklist',
  '',
  '- [ ] I read the contributing guide',
].join('\n');

describe('fillPrTemplate', () => {
  it("fills the template's sections and keeps the ones it has no data for", () => {
    const body = fillPrTemplate(TEMPLATE, {
      Summary: 'Plan **x** with 2 job(s).',
      Changes: '| Job | Status |',
      Testing: '- [x] tests passed',
    });

    expect(body).toContain('## Summary\n\nPlan **x** with 2 job(s).');
    expect(body).toContain('## Changes\n\n| Job | Status |');
    expect(body).toContain('## Testing\n\n- [x] tests passed');
    expect(body).not.toContain('Brief description of the changes.');
    expect(body).not.toContain('- [ ] `bun test` passes');
    expect(body).toContain('## Checklist\n\n- [ ] I read the contributing guide');
  });

  it('matches headings case-insensitively and appends sections the template lacks', () => {
    const body = fillPrTemplate('## SUMMARY\n\nold', { Summary: 'new', Notes: '- base: abc' });

    expect(body).toBe('## SUMMARY\n\nnew\n\n## Notes\n\n- base: abc');
  });
});

describe('loadPrTemplate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-pr-template-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the template where GitHub looks for it', async () => {
    mkdirSync(join(dir, '.github'));
    writeFileSync(join(dir, '.github', 'pull_request_template.md'), '## Summary\n');

    expect(await loadPrTemplate(dir)).toBe('## Summary\n');
  });

  it('returns null without a template', async () => {
    expect(await loadPrTemplate(dir)).toBeNull();
  });
});
