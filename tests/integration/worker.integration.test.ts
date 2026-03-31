import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { Job } from 'bullmq';

import type { ProviderConfig } from '../../src/config';
import { resetSettings } from '../../src/config';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

// Mock the gateway client so tests don't invoke a real subprocess
const { mockSendToSession } = vi.hoisted(() => ({
  mockSendToSession: vi.fn().mockResolvedValue({ runId: 'test-run', status: 'started' }),
}));
vi.mock('../../src/services/gateway-client.service', () => ({
  sendToSession: mockSendToSession,
}));

import { processJob } from '../../src/services/worker.service';

function createFakeJob(data: string, id = 'integration-job-1'): Job<string> {
  return { id, data } as unknown as Job<string>;
}

const provider: ProviderConfig = {
  name: 'integration-test',
  routePath: '/hooks/integration',
  hmacSecret: 'integration-secret',
  signatureStrategy: 'websub',
  openclawHookUrl: 'http://unused',
};

describe('Worker integration (gateway client sendToSession)', () => {
  beforeAll(() => {
    process.env.OPENCLAW_TOKEN = 'integration-test-token';
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
  });

  afterEach(() => {
    mockSendToSession.mockClear();
  });

  afterAll(() => {
    delete process.env.OPENCLAW_TOKEN;
    delete process.env.OPENCLAW_AGENT_ID;
    resetSettings();
  });

  it('should deliver job message to agent main session via sendToSession', async () => {
    const payload = '{"event":"updated"}';

    await processJob(createFakeJob(payload), provider);

    expect(mockSendToSession).toHaveBeenCalledOnce();
    const call = mockSendToSession.mock.calls[0][0];
    expect(call.key).toBe('agent:patch:main');
    expect(call.message).toBe(payload);
  });

  it('should include idempotencyKey in sendToSession call', async () => {
    await processJob(createFakeJob('{"event":"updated"}', 'job-xyz'), provider);

    const call = mockSendToSession.mock.calls[0][0];
    expect(call.idempotencyKey).toBe('clawndom:integration-test:job-xyz');
  });

  it('should process multiple jobs sequentially', async () => {
    await processJob(createFakeJob('{"event":"first"}', 'job-1'), provider);
    await processJob(createFakeJob('{"event":"second"}', 'job-2'), provider);

    expect(mockSendToSession).toHaveBeenCalledTimes(2);
    expect(mockSendToSession.mock.calls[0][0].message).toBe('{"event":"first"}');
    expect(mockSendToSession.mock.calls[1][0].message).toBe('{"event":"second"}');
  });
});
