import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { Job } from 'bullmq';
import type { AddressInfo } from 'node:net';

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

function createFakeJob(data: string): Job<string> {
  return { id: 'integration-job-1', data } as unknown as Job<string>;
}

describe('Worker integration', () => {
  let server: Server;
  let provider: ProviderConfig;
  let receivedRequests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
    body: string;
  }>;

  beforeAll(async () => {
    receivedRequests = [];

    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        receivedRequests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: {
            'content-type': request.headers['content-type'],
            authorization: request.headers['authorization'],
          },
          body: Buffer.concat(chunks).toString('utf-8'),
        });

        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end('');
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address() as AddressInfo;

    provider = {
      name: 'integration-test',
      routePath: '/hooks/integration',
      hmacSecret: 'integration-secret',
      signatureStrategy: 'websub',
      openclawHookUrl: `http://127.0.0.1:${address.port}/hooks/integration`,
    };
  });

  afterEach(() => {
    receivedRequests = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('should POST job data to OpenClaw and resolve on 202', async () => {
    const payload = '{"event":"updated"}';

    await processJob(createFakeJob(payload), provider);

    expect(receivedRequests).toHaveLength(1);
    const [request] = receivedRequests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/hooks/integration');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['authorization']).toBe('Bearer test-openclaw-token');
    expect(request.body).toBe(payload);
  });

  it('should process multiple jobs sequentially', async () => {
    await processJob(createFakeJob('{"event":"first"}'), provider);
    await processJob(createFakeJob('{"event":"second"}'), provider);

    expect(receivedRequests).toHaveLength(2);
    expect(receivedRequests[0].body).toBe('{"event":"first"}');
    expect(receivedRequests[1].body).toBe('{"event":"second"}');
  });
});
