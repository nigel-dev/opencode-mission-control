import type { JobSpec } from './plan-types';
import { sendPrompt, waitForServer } from './sdk-client';

export interface RelayContext {
  finding: string;
  filePath?: string;
  lineNumber?: number;
  severity?: 'info' | 'warning' | 'error';
}

export interface RelayMessage {
  from: string;
  to: string;
  context: RelayContext;
  timestamp: string;
}

export class JobComms {
  private messageBus: Map<string, RelayMessage[]> = new Map();
  private relayPatterns: Map<string, Bun.Glob[]> = new Map();
  private relayPatternSources: Map<string, string[]> = new Map();

  registerJob(job: JobSpec): void {
    if (job.relayPatterns && job.relayPatterns.length > 0) {
      const patterns: Bun.Glob[] = [];
      const sources: string[] = [];
      for (const pattern of job.relayPatterns) {
        const normalized = pattern.endsWith('/') ? `${pattern}**` : pattern;
        patterns.push(new Bun.Glob(normalized));
        sources.push(pattern);
      }
      this.relayPatterns.set(job.name, patterns);
      this.relayPatternSources.set(job.name, sources);
    }
    if (!this.messageBus.has(job.name)) {
      this.messageBus.set(job.name, []);
    }
  }

  unregisterJob(jobName: string): void {
    this.relayPatterns.delete(jobName);
    this.relayPatternSources.delete(jobName);
    this.messageBus.delete(jobName);
  }

  relayFinding(from: string, to: string, context: RelayContext): void {
    const message: RelayMessage = {
      from,
      to,
      context,
      timestamp: new Date().toISOString(),
    };

    const messages = this.messageBus.get(to) ?? [];
    messages.push(message);
    this.messageBus.set(to, messages);
  }

  getMessagesForJob(jobName: string): RelayMessage[] {
    return this.messageBus.get(jobName) ?? [];
  }

  clearMessagesForJob(jobName: string): void {
    this.messageBus.set(jobName, []);
  }

  shouldRelayForFile(jobName: string, filePath: string): boolean {
    const patterns = this.relayPatterns.get(jobName);
    if (!patterns || patterns.length === 0) {
      return false;
    }
    return patterns.some((pattern) => pattern.match(filePath));
  }

  async deliverMessages(
    job: JobSpec,
    options?: { filterFrom?: string[] },
  ): Promise<number> {
    const messages = this.getMessagesForJob(job.name);
    if (messages.length === 0) {
      return 0;
    }

    const filtered = options?.filterFrom
      ? messages.filter((m) => options.filterFrom!.includes(m.from))
      : messages;

    if (filtered.length === 0) {
      return 0;
    }

    if (!job.port) {
      return 0;
    }

    try {
      const client = await waitForServer(job.port, { timeoutMs: 5000 });

      for (const message of filtered) {
        const prompt = this.formatRelayPrompt(message);
        await sendPrompt(client, job.launchSessionID ?? '', prompt);
      }

      this.clearMessagesForJob(job.name);
      return filtered.length;
    } catch {
      return 0;
    }
  }

  private formatRelayPrompt(message: RelayMessage): string {
    const { from, context } = message;
    const { finding, filePath, lineNumber, severity } = context;

    const parts: string[] = [`[Inter-Job Communication from ${from}]`];

    if (severity) {
      parts.push(`Severity: ${severity.toUpperCase()}`);
    }

    parts.push(`Finding: ${finding}`);

    if (filePath) {
      parts.push(`File: ${filePath}`);
    }

    if (lineNumber) {
      parts.push(`Line: ${lineNumber}`);
    }

    parts.push('\nConsider how this finding may affect your current work.');

    return parts.join('\n');
  }

  getAllRegisteredJobs(): string[] {
    return Array.from(this.messageBus.keys());
  }

  getRelayPatternsForJob(jobName: string): string[] | undefined {
    return this.relayPatternSources.get(jobName);
  }
}
