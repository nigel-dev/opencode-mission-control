import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockSessionList = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionPromptAsync = vi.fn();
const mockSessionFork = vi.fn();

const mockClient = {
  session: {
    list: mockSessionList,
    create: mockSessionCreate,
    promptAsync: mockSessionPromptAsync,
    fork: mockSessionFork,
  },
};

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn(() => mockClient),
}));

const sdk = await import('@opencode-ai/sdk');
const { createJobClient, waitForServer, sendPrompt, createSessionAndPrompt, forkJobSession } = await import('../../src/lib/sdk-client');

describe('sdk-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createJobClient', () => {
    it('should create client with correct baseUrl', () => {
      createJobClient(14100);

      expect(sdk.createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'http://127.0.0.1:14100',
        }),
      );
    });

    it('should add auth header when password provided', () => {
      createJobClient(14100, 'secret');

      const expectedAuth = 'Basic ' + Buffer.from('opencode:secret').toString('base64');
      expect(sdk.createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: expectedAuth },
        }),
      );
    });

    it('should not include auth header when no password', () => {
      createJobClient(14100);

      expect(sdk.createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
      );
    });
  });

  describe('waitForServer', () => {
    it('should return client when server responds immediately', async () => {
      mockSessionList.mockResolvedValue({ data: [] });

      const client = await waitForServer(14100);
      expect(client).toBeDefined();
      expect(client.session).toBeDefined();
    });

    it('should retry until server responds', async () => {
      mockSessionList
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ data: [] });

      const client = await waitForServer(14100);
      expect(client).toBeDefined();
      expect(mockSessionList).toHaveBeenCalledTimes(3);
    });

    it('should throw on timeout', async () => {
      mockSessionList.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        waitForServer(14100, { timeoutMs: 500 }),
      ).rejects.toThrow('did not become ready within 500ms');
    });

    it('should pass password to client', async () => {
      mockSessionList.mockResolvedValue({ data: [] });

      await waitForServer(14100, { password: 'secret' });

      const expectedAuth = 'Basic ' + Buffer.from('opencode:secret').toString('base64');
      expect(sdk.createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: expectedAuth },
        }),
      );
    });
  });

  describe('sendPrompt', () => {
    it('should call promptAsync with correct parameters', async () => {
      mockSessionPromptAsync.mockResolvedValue({ data: {} });

      await sendPrompt(mockClient as any, 'session-1', 'Hello');

      expect(mockSessionPromptAsync).toHaveBeenCalledWith({
        path: { id: 'session-1' },
        body: {
          parts: [{ type: 'text', text: 'Hello' }],
        },
      });
    });

    it('should include agent when provided', async () => {
      mockSessionPromptAsync.mockResolvedValue({ data: {} });

      await sendPrompt(mockClient as any, 'session-1', 'Hello', 'build');

      expect(mockSessionPromptAsync).toHaveBeenCalledWith({
        path: { id: 'session-1' },
        body: {
          parts: [{ type: 'text', text: 'Hello' }],
          agent: 'build',
        },
      });
    });

    it('should include model when provided', async () => {
      mockSessionPromptAsync.mockResolvedValue({ data: {} });

      const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
      await sendPrompt(mockClient as any, 'session-1', 'Hello', undefined, model);

      expect(mockSessionPromptAsync).toHaveBeenCalledWith({
        path: { id: 'session-1' },
        body: {
          parts: [{ type: 'text', text: 'Hello' }],
          model,
        },
      });
    });

    it('should wrap errors with context', async () => {
      mockSessionPromptAsync.mockRejectedValue(new Error('network error'));

      await expect(
        sendPrompt(mockClient as any, 'session-1', 'Hello'),
      ).rejects.toThrow('Failed to send prompt to session session-1');
    });
  });

  describe('createSessionAndPrompt', () => {
    it('should create session and send prompt', async () => {
      mockSessionCreate.mockResolvedValue({
        data: { id: 'new-session-id', title: 'test' },
      });
      mockSessionPromptAsync.mockResolvedValue({ data: {} });

      const sessionId = await createSessionAndPrompt(mockClient as any, 'Hello');

      expect(sessionId).toBe('new-session-id');
      expect(mockSessionCreate).toHaveBeenCalled();
      expect(mockSessionPromptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { id: 'new-session-id' },
        }),
      );
    });

    it('should throw when session creation fails', async () => {
      mockSessionCreate.mockResolvedValue({
        data: undefined,
        error: { message: 'server error' },
      });

      await expect(
        createSessionAndPrompt(mockClient as any, 'Hello'),
      ).rejects.toThrow('Failed to create session');
    });
  });

  describe('forkJobSession', () => {
    it('should call session.fork with source session ID', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });
      mockSessionPromptAsync.mockResolvedValue({ data: {} });

      const newId = await forkJobSession(mockClient as any, 'source-session', {
        sourceJobName: 'api-job',
        newJobName: 'api-job-v2',
        additionalPrompt: 'Continue the API work',
      });

      expect(newId).toBe('forked-session-id');
      expect(mockSessionFork).toHaveBeenCalledWith({
        path: { id: 'source-session' },
        body: {},
      });
    });

    it('should send context prompt to forked session when additionalPrompt provided', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });
      mockSessionPromptAsync.mockResolvedValue({ data: {} });

      await forkJobSession(mockClient as any, 'source-session', {
        sourceJobName: 'db-schema',
        newJobName: 'db-schema-v2',
        additionalPrompt: 'Add indexes',
      });

      expect(mockSessionPromptAsync).toHaveBeenCalledWith({
        path: { id: 'forked-session-id' },
        body: {
          parts: [{
            type: 'text',
            text: expect.stringContaining('Forked from job "db-schema" as "db-schema-v2"'),
          }],
        },
      });
    });

    it('should include additional prompt in context message', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });
      mockSessionPromptAsync.mockResolvedValue({ data: {} });

      await forkJobSession(mockClient as any, 'source-session', {
        sourceJobName: 'src',
        newJobName: 'dst',
        additionalPrompt: 'Focus on error handling',
      });

      expect(mockSessionPromptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            parts: [{
              type: 'text',
              text: expect.stringContaining('Focus on error handling'),
            }],
          },
        }),
      );
    });

    it('should not send prompt when additionalPrompt is not provided', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });

      const newId = await forkJobSession(mockClient as any, 'source-session', {
        sourceJobName: 'src',
        newJobName: 'dst',
      });

      expect(newId).toBe('forked-session-id');
      expect(mockSessionPromptAsync).not.toHaveBeenCalled();
    });

    it('should pass agent and model to sendPrompt when provided', async () => {
      mockSessionFork.mockResolvedValue({
        data: { id: 'forked-session-id' },
      });
      mockSessionPromptAsync.mockResolvedValue({ data: {} });

      const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
      await forkJobSession(mockClient as any, 'source-session', {
        sourceJobName: 'src',
        newJobName: 'dst',
        additionalPrompt: 'Continue',
        agent: 'build',
        model,
      });

      expect(mockSessionPromptAsync).toHaveBeenCalledWith({
        path: { id: 'forked-session-id' },
        body: {
          parts: [{ type: 'text', text: expect.any(String) }],
          agent: 'build',
          model,
        },
      });
    });

    it('should throw when fork call fails', async () => {
      mockSessionFork.mockResolvedValue({
        data: undefined,
        error: { message: 'fork not supported' },
      });

      await expect(
        forkJobSession(mockClient as any, 'source-session', {
          sourceJobName: 'src',
          newJobName: 'dst',
        }),
      ).rejects.toThrow('Failed to fork session');
    });
  });
});
