import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { JobSpec } from '../../src/lib/plan-types';
import { JobComms, type RelayContext } from '../../src/lib/job-comms';
import * as sdkClientMod from '../../src/lib/sdk-client';

function makeJob(name: string, overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    id: `${name}-id`,
    name,
    prompt: `do ${name}`,
    status: 'running',
    ...overrides,
  };
}

describe('JobComms', () => {
  let comms: JobComms;

  beforeEach(() => {
    comms = new JobComms();
  });

  afterEach(() => {
    mock.restore();
  });

  describe('registerJob / unregisterJob', () => {
    it('registers a job and makes it visible in getAllRegisteredJobs', () => {
      comms.registerJob(makeJob('alpha'));

      expect(comms.getAllRegisteredJobs()).toContain('alpha');
    });

    it('unregisters a job and removes it from all lookups', () => {
      comms.registerJob(makeJob('alpha', { relayPatterns: ['src/**'] }));
      comms.unregisterJob('alpha');

      expect(comms.getAllRegisteredJobs()).not.toContain('alpha');
      expect(comms.getRelayPatternsForJob('alpha')).toBeUndefined();
    });

    it('registers relay patterns from job spec', () => {
      comms.registerJob(makeJob('alpha', { relayPatterns: ['src/**', 'tests/'] }));

      expect(comms.getRelayPatternsForJob('alpha')).toEqual(['src/**', 'tests/']);
    });

    it('does not register patterns when relayPatterns is empty', () => {
      comms.registerJob(makeJob('alpha', { relayPatterns: [] }));

      expect(comms.getRelayPatternsForJob('alpha')).toBeUndefined();
    });
  });

  describe('relayFinding', () => {
    it('stores a message in the target job message bus', () => {
      comms.registerJob(makeJob('sender'));
      comms.registerJob(makeJob('receiver'));

      const context: RelayContext = {
        finding: 'API signature changed',
        filePath: 'src/api.ts',
        lineNumber: 42,
        severity: 'warning',
      };
      comms.relayFinding('sender', 'receiver', context);

      const messages = comms.getMessagesForJob('receiver');
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('sender');
      expect(messages[0].to).toBe('receiver');
      expect(messages[0].context.finding).toBe('API signature changed');
      expect(messages[0].context.filePath).toBe('src/api.ts');
      expect(messages[0].context.lineNumber).toBe(42);
      expect(messages[0].context.severity).toBe('warning');
      expect(messages[0].timestamp).toBeTruthy();
    });

    it('accumulates multiple messages for the same target', () => {
      comms.registerJob(makeJob('a'));
      comms.registerJob(makeJob('b'));

      comms.relayFinding('a', 'b', { finding: 'first' });
      comms.relayFinding('a', 'b', { finding: 'second' });

      expect(comms.getMessagesForJob('b')).toHaveLength(2);
    });

    it('stores messages even for unregistered targets', () => {
      comms.relayFinding('unknown-sender', 'unknown-receiver', { finding: 'orphan' });

      const messages = comms.getMessagesForJob('unknown-receiver');
      expect(messages).toHaveLength(1);
      expect(messages[0].context.finding).toBe('orphan');
    });
  });

  describe('getMessagesForJob / clearMessagesForJob', () => {
    it('returns empty array when no messages exist', () => {
      expect(comms.getMessagesForJob('nonexistent')).toEqual([]);
    });

    it('clears messages for a job', () => {
      comms.registerJob(makeJob('target'));
      comms.relayFinding('source', 'target', { finding: 'msg' });

      comms.clearMessagesForJob('target');

      expect(comms.getMessagesForJob('target')).toHaveLength(0);
    });
  });

  describe('shouldRelayForFile', () => {
    it('returns true when file matches a relay pattern', () => {
      comms.registerJob(makeJob('alpha', { relayPatterns: ['src/**'] }));

      expect(comms.shouldRelayForFile('alpha', 'src/lib/foo.ts')).toBe(true);
    });

    it('returns false when file does not match any pattern', () => {
      comms.registerJob(makeJob('alpha', { relayPatterns: ['src/**'] }));

      expect(comms.shouldRelayForFile('alpha', 'tests/foo.test.ts')).toBe(false);
    });

    it('returns false for unregistered job', () => {
      expect(comms.shouldRelayForFile('nonexistent', 'src/foo.ts')).toBe(false);
    });

    it('handles trailing slash pattern (directory prefix)', () => {
      comms.registerJob(makeJob('alpha', { relayPatterns: ['docs/'] }));

      expect(comms.shouldRelayForFile('alpha', 'docs/guide.md')).toBe(true);
      expect(comms.shouldRelayForFile('alpha', 'src/app.ts')).toBe(false);
    });

    it('returns false when job has no relay patterns', () => {
      comms.registerJob(makeJob('alpha'));

      expect(comms.shouldRelayForFile('alpha', 'src/foo.ts')).toBe(false);
    });
  });

  describe('deliverMessages', () => {
    it('delivers messages to job via SDK and clears queue', async () => {
      const mockClient = { session: { promptAsync: async () => ({}) } };
      const waitSpy = spyOn(sdkClientMod, 'waitForServer').mockResolvedValue(mockClient as any);
      const sendSpy = spyOn(sdkClientMod, 'sendPrompt').mockResolvedValue();

      comms.registerJob(makeJob('target'));
      comms.relayFinding('source', 'target', {
        finding: 'Schema change detected',
        filePath: 'src/schema.ts',
        severity: 'error',
      });

      const job = makeJob('target', { port: 14100, launchSessionID: 'session-1' });
      const delivered = await comms.deliverMessages(job);

      expect(delivered).toBe(1);
      expect(waitSpy).toHaveBeenCalledWith(14100, { timeoutMs: 5000 });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(
        mockClient,
        'session-1',
        expect.stringContaining('Schema change detected'),
      );
      expect(comms.getMessagesForJob('target')).toHaveLength(0);
    });

    it('returns 0 when no messages exist for job', async () => {
      const job = makeJob('empty', { port: 14100, launchSessionID: 'session-1' });
      const delivered = await comms.deliverMessages(job);
      expect(delivered).toBe(0);
    });

    it('returns 0 when job has no port', async () => {
      comms.registerJob(makeJob('target'));
      comms.relayFinding('source', 'target', { finding: 'msg' });

      const job = makeJob('target');
      const delivered = await comms.deliverMessages(job);
      expect(delivered).toBe(0);
    });

    it('returns 0 when server connection fails', async () => {
      spyOn(sdkClientMod, 'waitForServer').mockRejectedValue(new Error('connection refused'));

      comms.registerJob(makeJob('target'));
      comms.relayFinding('source', 'target', { finding: 'msg' });

      const job = makeJob('target', { port: 14100, launchSessionID: 'session-1' });
      const delivered = await comms.deliverMessages(job);
      expect(delivered).toBe(0);
    });

    it('filters messages by source when filterFrom is specified', async () => {
      const mockClient = { session: { promptAsync: async () => ({}) } };
      spyOn(sdkClientMod, 'waitForServer').mockResolvedValue(mockClient as any);
      const sendSpy = spyOn(sdkClientMod, 'sendPrompt').mockResolvedValue();

      comms.registerJob(makeJob('target'));
      comms.relayFinding('job-a', 'target', { finding: 'from A' });
      comms.relayFinding('job-b', 'target', { finding: 'from B' });
      comms.relayFinding('job-c', 'target', { finding: 'from C' });

      const job = makeJob('target', { port: 14100, launchSessionID: 'session-1' });
      const delivered = await comms.deliverMessages(job, { filterFrom: ['job-a', 'job-c'] });

      expect(delivered).toBe(2);
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when filterFrom matches no messages', async () => {
      comms.registerJob(makeJob('target'));
      comms.relayFinding('job-a', 'target', { finding: 'from A' });

      const job = makeJob('target', { port: 14100, launchSessionID: 'session-1' });
      const delivered = await comms.deliverMessages(job, { filterFrom: ['nonexistent'] });
      expect(delivered).toBe(0);
    });

    it('formats relay prompt with all context fields', async () => {
      const mockClient = { session: { promptAsync: async () => ({}) } };
      spyOn(sdkClientMod, 'waitForServer').mockResolvedValue(mockClient as any);
      const sendSpy = spyOn(sdkClientMod, 'sendPrompt').mockResolvedValue();

      comms.registerJob(makeJob('target'));
      comms.relayFinding('api-job', 'target', {
        finding: 'Endpoint removed',
        filePath: 'src/routes.ts',
        lineNumber: 55,
        severity: 'error',
      });

      const job = makeJob('target', { port: 14100, launchSessionID: 'session-1' });
      await comms.deliverMessages(job);

      const promptArg = sendSpy.mock.calls[0][2];
      expect(promptArg).toContain('[Inter-Job Communication from api-job]');
      expect(promptArg).toContain('Severity: ERROR');
      expect(promptArg).toContain('Finding: Endpoint removed');
      expect(promptArg).toContain('File: src/routes.ts');
      expect(promptArg).toContain('Line: 55');
    });

    it('formats relay prompt without optional fields', async () => {
      const mockClient = { session: { promptAsync: async () => ({}) } };
      spyOn(sdkClientMod, 'waitForServer').mockResolvedValue(mockClient as any);
      const sendSpy = spyOn(sdkClientMod, 'sendPrompt').mockResolvedValue();

      comms.registerJob(makeJob('target'));
      comms.relayFinding('source', 'target', { finding: 'Simple message' });

      const job = makeJob('target', { port: 14100, launchSessionID: 'session-1' });
      await comms.deliverMessages(job);

      const promptArg = sendSpy.mock.calls[0][2];
      expect(promptArg).toContain('Finding: Simple message');
      expect(promptArg).not.toContain('Severity:');
      expect(promptArg).not.toContain('File:');
      expect(promptArg).not.toContain('Line:');
    });
  });

  describe('getAllRegisteredJobs', () => {
    it('returns all registered job names', () => {
      comms.registerJob(makeJob('a'));
      comms.registerJob(makeJob('b'));
      comms.registerJob(makeJob('c'));

      const jobs = comms.getAllRegisteredJobs();
      expect(jobs).toHaveLength(3);
      expect(jobs).toContain('a');
      expect(jobs).toContain('b');
      expect(jobs).toContain('c');
    });
  });
});
