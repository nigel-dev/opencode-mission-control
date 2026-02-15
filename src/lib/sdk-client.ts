import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

export function createJobClient(
  port: number,
  password?: string,
): OpencodeClient {
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = {};

  if (password) {
    headers['Authorization'] =
      'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  }

  return createOpencodeClient({
    baseUrl,
    headers,
  });
}

export interface WaitForServerOptions {
  timeoutMs?: number;
  password?: string;
}

/**
 * Wait for an opencode serve instance to become ready.
 * Polls with exponential backoff until the server responds.
 */
export async function waitForServer(
  port: number,
  options?: WaitForServerOptions,
): Promise<OpencodeClient> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const client = createJobClient(port, options?.password);

  const startTime = Date.now();
  let delay = 100;
  const maxDelay = 5_000;
  const backoffFactor = 1.5;

  while (Date.now() - startTime < timeoutMs) {
    try {
      await client.session.list();
      return client;
    } catch {
      const remaining = timeoutMs - (Date.now() - startTime);
      const waitTime = Math.min(delay, remaining, maxDelay);
      if (waitTime <= 0) break;

      await new Promise((resolve) => setTimeout(resolve, waitTime));
      delay = Math.min(delay * backoffFactor, maxDelay);
    }
  }

  throw new Error(
    `Server on port ${port} did not become ready within ${timeoutMs}ms`,
  );
}

/**
 * Send a prompt to a session via the SDK.
 * Uses promptAsync to return immediately without waiting for completion.
 */
export async function sendPrompt(
  client: OpencodeClient,
  sessionId: string,
  prompt: string,
  agent?: string,
  model?: { providerID: string; modelID: string },
): Promise<void> {
  try {
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to send prompt to session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function createSessionAndPrompt(
  client: OpencodeClient,
  prompt: string,
  agent?: string,
  model?: { providerID: string; modelID: string },
): Promise<string> {
  const result = await client.session.create();

  if (!result.data) {
    throw new Error(
      `Failed to create session: ${result.error ? JSON.stringify(result.error) : 'unknown error'}`,
    );
  }

  const sessionId = result.data.id;
  await sendPrompt(client, sessionId, prompt, agent, model);
  return sessionId;
}
