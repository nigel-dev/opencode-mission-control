import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockSessionList = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionPromptAsync = vi.fn();

const mockClient = {
  session: {
    list: mockSessionList,
    create: mockSessionCreate,
    promptAsync: mockSessionPromptAsync,
  },
};

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn(() => mockClient),
}));

const sdk = await import('@opencode-ai/sdk');
const { createJobClient, waitForServer, sendPrompt, createSessionAndPrompt } = await import('../../src/lib/sdk-client');

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
});
