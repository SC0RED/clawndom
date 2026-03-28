import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

import type { ProviderConfig } from '../../src/config';
import type { GatewayClient, AgentRunResult } from '../../src/services/gateway-client';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { processJob } from '../../src/services/worker.service';

const testProvider: ProviderConfig = {
  name: 'test-provider',
  routePath: '/hooks/test',
  hmacSecret: 'test-hmac-secret',
  signatureStrategy: 'websub',
  openclawHookUrl: 'http://127.0.0.1:18789/hooks/test',
};

function createFakeJob(data: string, id = 'test-job-1'): Job<string> {
  return { id, data } as unknown as Job<string>;
}

function createMockGatewayClient(result: AgentRunResult): GatewayClient {
  return {
    runAndWait: vi.fn().mockResolvedValue(result),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as GatewayClient;
}

describe('processJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should resolve when agent run completes with ok status', async () => {
    const client = createMockGatewayClient({
      runId: 'run-123',
      status: 'ok',
      startedAt: '2026-03-28T10:00:00Z',
      endedAt: '2026-03-28T10:00:05Z',
    });

    await expect(
      processJob(createFakeJob('{"event":"updated"}'), testProvider, client),
    ).resolves.toBeUndefined();

    expect(client.runAndWait).toHaveBeenCalledWith(
      {
        message: '{"event":"updated"}',
        sessionKey: 'hook:test-provider:test-job-1',
        name: 'test-provider',
        deliver: true,
      },
      expect.any(Number),
    );
  });

  it('should throw when agent run completes with error status', async () => {
    const client = createMockGatewayClient({
      runId: 'run-456',
      status: 'error',
      error: 'Model rate limited',
    });

    await expect(processJob(createFakeJob('{}'), testProvider, client)).rejects.toThrow(
      'Agent run failed: Model rate limited',
    );
  });

  it('should resolve (with warning) when agent run times out', async () => {
    const client = createMockGatewayClient({
      runId: 'run-789',
      status: 'timeout',
    });

    await expect(processJob(createFakeJob('{}'), testProvider, client)).resolves.toBeUndefined();
  });

  it('should propagate gateway client errors', async () => {
    const client = {
      runAndWait: vi.fn().mockRejectedValue(new Error('Gateway WS closed')),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as GatewayClient;

    await expect(processJob(createFakeJob('{}'), testProvider, client)).rejects.toThrow(
      'Gateway WS closed',
    );
  });

  it('should include provider name in session key', async () => {
    const client = createMockGatewayClient({ runId: 'r1', status: 'ok' });

    await processJob(createFakeJob('{}', 'job-42'), testProvider, client);

    expect(client.runAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'hook:test-provider:job-42' }),
      expect.any(Number),
    );
  });
});
