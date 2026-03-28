import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';

import type { ProviderConfig } from '../../src/config';

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

function createFakeJob(data: string): Job<string> {
  return { id: 'test-job-1', data } as unknown as Job<string>;
}

describe('processJob', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should resolve when fetch returns 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    await expect(
      processJob(createFakeJob('{"event":"updated"}'), testProvider),
    ).resolves.toBeUndefined();
  });

  it('should resolve when fetch returns 202', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
    });

    await expect(
      processJob(createFakeJob('{"event":"created"}'), testProvider),
    ).resolves.toBeUndefined();
  });

  it('should throw when OpenClaw returns 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    });

    await expect(processJob(createFakeJob('{}'), testProvider)).rejects.toThrow(
      'OpenClaw returned 500',
    );
  });

  it('should throw when OpenClaw returns 400', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('Bad Request'),
    });

    await expect(processJob(createFakeJob('{}'), testProvider)).rejects.toThrow(
      'OpenClaw returned 400',
    );
  });

  it('should propagate network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(processJob(createFakeJob('{}'), testProvider)).rejects.toThrow('ECONNREFUSED');
  });

  it('should send correct headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    await processJob(createFakeJob('{}'), testProvider);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-openclaw-token',
        },
      }),
    );
  });

  it('should use provider openclawHookUrl', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    await processJob(createFakeJob('{}'), testProvider);

    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:18789/hooks/test', expect.any(Object));
  });

  it('should send job data as request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;
    const payload = '{"event":"updated","type":"generic"}';

    await processJob(createFakeJob(payload), testProvider);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: payload }),
    );
  });
});
