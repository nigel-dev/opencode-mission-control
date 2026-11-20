import { join } from 'path';

const TEMPLATE_CANDIDATES = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  '.github/PULL_REQUEST_TEMPLATE/pull_request_template.md',
];

/** The repository's pull request template, looked up where GitHub looks for it. */
export async function loadPrTemplate(cwd: string): Promise<string | null> {
  for (const candidate of TEMPLATE_CANDIDATES) {
    try {
      const file = Bun.file(join(cwd, candidate));
      if (await file.exists()) {
        return await file.text();
      }
    } catch (error) {
      console.warn(`[Mission Control] Could not read the PR template ${candidate}:`, error);
    }
  }
  return null;
}

/**
 * Fill a PR template's sections. Each `## Heading` whose name matches a key of
 * `sections` (case-insensitively) gets that content as its body; other
 * sections are kept as the template has them. Content for headings the
 * template does not have is appended as new sections, so nothing is lost.
 */
export function fillPrTemplate(template: string, sections: Record<string, string>): string {
  const wanted = new Map(Object.entries(sections).map(([name, content]) => [name.toLowerCase(), { name, content }]));
  const lines = template.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const match = wanted.get(heading[1].toLowerCase());
      out.push(line);
      if (match) {
        out.push('', match.content, '');
        wanted.delete(heading[1].toLowerCase());
        skipping = true;
      } else {
        skipping = false;
      }
      continue;
    }
    if (/^#\s/.test(line)) {
      skipping = false;
    }
    if (!skipping) {
      out.push(line);
    }
  }

  for (const { name, content } of wanted.values()) {
    out.push('', `## ${name}`, '', content, '');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
