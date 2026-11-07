import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { OpencodeClient } from '../../src/lib/sdk-client';

const mockSessionList = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionGet = vi.fn();
const mockSessionFork = vi.fn();
const mockSessionPrompt = vi.fn();
const mockSessionSwitchAgent = vi.fn();
const mockSessionSwitchModel = vi.fn();

const mockClient = {
  session: {
    list: mockSessionList,
    create: mockSessionCreate,
    get: mockSessionGet,
    fork: mockSessionFork,
    prompt: mockSessionPrompt,
    switchAgent: mockSessionSwitchAgent,
    switchModel: mockSessionSwitchModel,
  },
};

vi.mock('@opencode/client', () => ({
  OpenCode: { make: vi.fn(() => mockClient) },
}));

const mod = await import('@opencode/client');
const { createJobClient, waitForServer, sendPrompt, createSessionAndPrompt, forkJobSession } = await import('../../src/lib/sdk-client');

const asClient = (client: typeof mockClient): OpencodeClient =>
  client as unknown as OpencodeClient;

describe('sdk-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createJobClient', () => {
    it('should create client with correct baseUrl and empty headers', () => {
      createJobClient(14100);

      expect(mod.OpenCode.make).toHaveBeenCalledWith({
        baseUrl: 'http://127.0.0.1:14100',
        headers: {},
      });
    });

    it('should add auth header when password provided', () => {
      createJobClient(14100, 'secret');

      const expectedAuth = 'Basic ' + Buffer.from('opencode:secret').toString('base64');
      expect(mod.OpenCode.make).toHaveBeenCalledWith({
        baseUrl: 'http://127.0.0.1:14100',
        headers: { Authorization: expectedAuth },
      });
    });
  });

  describe('waitForServer', () => {
    it('should return client when server responds immediately', async () => {
      mockSessionList.mockResolvedValue({ data: [], cursor: {} });

      const client = await waitForServer(14100);
      expect(client).toBe(mockClient);
      expect(client.session).toBeDefined();
      expect(mockSessionList).toHaveBeenCalledTimes(1);
    });

    it('should retry until server responds', async () => {
      mockSessionList
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ data: [], cursor: {} });

      const client = await waitForServer(14100);
      expect(client).toBe(mockClient);
      expect(mockSessionList).toHaveBeenCalledTimes(3);
    });

    it('should throw exact timeout error', async () => {
      mockSessionList.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        waitForServer(14100, { timeoutMs: 500 }),
      ).rejects.toThrow('Server on port 14100 did not become ready within 500ms');
    });

    it('should forward password to createJobClient', async () => {
      mockSessionList.mockResolvedValue({ data: [], cursor: {} });

      await waitForServer(14100, { password: 'secret' });

      const expectedAuth = 'Basic ' + Buffer.from('opencode:secret').toString('base64');
      expect(mod.OpenCode.make).toHaveBeenCalledWith({
        baseUrl: 'http://127.0.0.1:14100',
        headers: { Authorization: expectedAuth },
      });
    });
  });

  describe('sendPrompt', () => {
    it('should call prompt with sessionID and text only', async () => {
      mockSessionPrompt.mockResolvedValue({});

      await sendPrompt(asClient(mockClient), 'session-1', 'Hello');

      expect(mockSessionSwitchAgent).not.toHaveBeenCalled();
      expect(mockSessionSwitchModel).not.toHaveBeenCalled();
      expect(mockSessionPrompt).toHaveBeenCalledWith({
        sessionID: 'session-1',
        text: 'Hello',
      });
    });

    it('should switch agent when provided', async () => {
      mockSessionSwitchAgent.mockResolvedValue(undefined);
      mockSessionPrompt.mockResolvedValue({});

      await sendPrompt(asClient(mockClient), 'session-1', 'Hello', 'build');

      expect(mockSessionSwitchAgent).toHaveBeenCalledWith({
        sessionID: 'session-1',
        agent: 'build',
      });
      expect(mockSessionPrompt).toHaveBeenCalledWith({
        sessionID: 'session-1',
        text: 'Hello',
      });
    });

    it('should switch model when provided', async () => {
      mockSessionSwitchModel.mockResolvedValue(undefined);
      mockSessionPrompt.mockResolvedValue({});

      const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
      await sendPrompt(asClient(mockClient), 'session-1', 'Hello', undefined, model);

      expect(mockSessionSwitchModel).toHaveBeenCalledWith({
        sessionID: 'session-1',
        model: { id: 'claude-sonnet-4-20250514', providerID: 'anthropic' },
      });
      expect(mockSessionPrompt).toHaveBeenCalledWith({
        sessionID: 'session-1',
        text: 'Hello',
      });
    });

    it('should switch agent and model before prompting', async () => {
      mockSessionSwitchAgent.mockResolvedValue(undefined);
      mockSessionSwitchModel.mockResolvedValue(undefined);
      mockSessionPrompt.mockResolvedValue({});

      const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
      await sendPrompt(asClient(mockClient), 'session-1', 'Hello', 'build', model);

      expect(mockSessionSwitchAgent).toHaveBeenCalledWith({
        sessionID: 'session-1',
        agent: 'build',
      });
      expect(mockSessionSwitchModel).toHaveBeenCalledWith({
        sessionID: 'session-1',
        model: { id: 'claude-sonnet-4-20250514', providerID: 'anthropic' },
      });
      expect(mockSessionPrompt).toHaveBeenCalledWith({
        sessionID: 'session-1',
        text: 'Hello',
      });
    });

    it('should wrap errors with exact context', async () => {
      mockSessionPrompt.mockRejectedValue(new Error('network error'));

      await expect(
        sendPrompt(asClient(mockClient), 'session-1', 'Hello'),
      ).rejects.toThrow('Failed to send prompt to session session-1: network error');
    });
  });

  describe('createSessionAndPrompt', () => {
    it('should create session and send prompt', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'new-session-id' });
      mockSessionPrompt.mockResolvedValue({});

      const sessionId = await createSessionAndPrompt(asClient(mockClient), 'Hello');

      expect(sessionId).toBe('new-session-id');
      expect(mockSessionCreate).toHaveBeenCalledWith({
        agent: undefined,
        model: undefined,
      });
      expect(mockSessionPrompt).toHaveBeenCalledWith({
        sessionID: 'new-session-id',
        text: 'Hello',
      });
    });

    it('should pass agent and model to session creation', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'new-session-id' });
      mockSessionPrompt.mockResolvedValue({});

      const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
      await createSessionAndPrompt(asClient(mockClient), 'Hello', 'build', model);

      expect(mockSessionCreate).toHaveBeenCalledWith({
        agent: 'build',
        model: { id: 'claude-sonnet-4-20250514', providerID: 'anthropic' },
      });
    });

    it('should throw exact error when session creation fails', async () => {
      mockSessionCreate.mockRejectedValue(new Error('server error'));

      await expect(
        createSessionAndPrompt(asClient(mockClient), 'Hello'),
      ).rejects.toThrow('Failed to create session: server error');
    });
  });

  describe('forkJobSession', () => {
    it('should call session.fork with source session ID', async () => {
      mockSessionFork.mockResolvedValue({ id: 'forked-session-id' });

      const newId = await forkJobSession(asClient(mockClient), 'source-session', {
        sourceJobName: 'api-job',
        newJobName: 'api-job-v2',
      });

      expect(newId).toBe('forked-session-id');
      expect(mockSessionFork).toHaveBeenCalledWith({
        sessionID: 'source-session',
      });
    });

    it('should send context prompt to forked session when additionalPrompt provided', async () => {
      mockSessionFork.mockResolvedValue({ id: 'forked-session-id' });
      mockSessionPrompt.mockResolvedValue({});

      await forkJobSession(asClient(mockClient), 'source-session', {
        sourceJobName: 'db-schema',
        newJobName: 'db-schema-v2',
        additionalPrompt: 'Add indexes',
      });

      expect(mockSessionPrompt).toHaveBeenCalledWith({
        sessionID: 'forked-session-id',
        text: expect.stringContaining('Forked from job "db-schema" as "db-schema-v2"'),
      });
    });

    it('should include additional prompt in context message', async () => {
      mockSessionFork.mockResolvedValue({ id: 'forked-session-id' });
      mockSessionPrompt.mockResolvedValue({});

      await forkJobSession(asClient(mockClient), 'source-session', {
        sourceJobName: 'src',
        newJobName: 'dst',
        additionalPrompt: 'Focus on error handling',
      });

      expect(mockSessionPrompt).toHaveBeenCalledWith({
        sessionID: 'forked-session-id',
        text: expect.stringContaining('Focus on error handling'),
      });
    });

    it('should not send prompt when additionalPrompt is not provided', async () => {
      mockSessionFork.mockResolvedValue({ id: 'forked-session-id' });

      const newId = await forkJobSession(asClient(mockClient), 'source-session', {
        sourceJobName: 'src',
        newJobName: 'dst',
      });

      expect(newId).toBe('forked-session-id');
      expect(mockSessionPrompt).not.toHaveBeenCalled();
    });

    it('should pass agent and model to sendPrompt when provided', async () => {
      mockSessionFork.mockResolvedValue({ id: 'forked-session-id' });
      mockSessionSwitchAgent.mockResolvedValue(undefined);
      mockSessionSwitchModel.mockResolvedValue(undefined);
      mockSessionPrompt.mockResolvedValue({});

      const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
      await forkJobSession(asClient(mockClient), 'source-session', {
        sourceJobName: 'src',
        newJobName: 'dst',
        additionalPrompt: 'Continue',
        agent: 'build',
        model,
      });

      expect(mockSessionSwitchAgent).toHaveBeenCalledWith({
        sessionID: 'forked-session-id',
        agent: 'build',
      });
      expect(mockSessionSwitchModel).toHaveBeenCalledWith({
        sessionID: 'forked-session-id',
        model: { id: 'claude-sonnet-4-20250514', providerID: 'anthropic' },
      });
      expect(mockSessionPrompt).toHaveBeenCalledWith({
        sessionID: 'forked-session-id',
        text: expect.any(String),
      });
    });

    it('should throw exact error when fork call fails', async () => {
      mockSessionFork.mockRejectedValue(new Error('fork not supported'));

      await expect(
        forkJobSession(asClient(mockClient), 'source-session', {
          sourceJobName: 'src',
          newJobName: 'dst',
        }),
      ).rejects.toThrow('Failed to fork session: fork not supported');
    });
  });
});
