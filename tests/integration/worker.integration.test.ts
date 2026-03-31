import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

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

/**
 * Minimal mock WebSocket gateway: accepts the connect handshake, then
 * acknowledges sessions.send calls and records the params.
 */
function createMockGateway(token: string): {
  server: Server;
  wss: WebSocketServer;
  receivedSends: Array<{ key: string; message: string; idempotencyKey?: string }>;
} {
  const receivedSends: Array<{ key: string; message: string; idempotencyKey?: string }> = [];
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as {
        type: string;
        id: string;
        method: string;
        params: Record<string, unknown>;
      };

      if (frame.method === 'connect') {
        const authToken = (frame.params.auth as { token?: string })?.token;
        if (authToken !== token) {
          ws.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: false,
              error: { code: 401, message: 'unauthorized' },
            }),
          );
          return;
        }
        ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        return;
      }

      if (frame.method === 'sessions.send') {
        const p = frame.params as { key: string; message: string; idempotencyKey?: string };
        receivedSends.push({ key: p.key, message: p.message, idempotencyKey: p.idempotencyKey });
        ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        return;
      }

      // Unknown method
      ws.send(
        JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: { code: 404, message: `unknown method: ${frame.method}` },
        }),
      );
    });
  });

  return { server: httpServer, wss, receivedSends };
}

describe('Worker integration (gateway WS sessions.send)', () => {
  const TEST_TOKEN = 'integration-test-token';
  let httpServer: Server;
  let wss: WebSocketServer;
  let receivedSends: Array<{ key: string; message: string; idempotencyKey?: string }>;

  beforeAll(() => {
    const mock = createMockGateway(TEST_TOKEN);
    httpServer = mock.server;
    wss = mock.wss;
    receivedSends = mock.receivedSends;

    httpServer.listen(0);
    const port = (httpServer.address() as AddressInfo).port;

    process.env.OPENCLAW_GATEWAY_WS_URL = `ws://127.0.0.1:${port}`;
    process.env.OPENCLAW_TOKEN = TEST_TOKEN;
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
  });

  afterEach(() => {
    receivedSends.length = 0;
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    delete process.env.OPENCLAW_GATEWAY_WS_URL;
    delete process.env.OPENCLAW_TOKEN;
    delete process.env.OPENCLAW_AGENT_ID;
    resetSettings();
  });

  it('should deliver job message to agent main session via sessions.send', async () => {
    const payload = '{"event":"updated"}';

    await processJob(createFakeJob(payload), provider);

    expect(receivedSends).toHaveLength(1);
    expect(receivedSends[0].key).toBe('agent:patch:main');
    expect(receivedSends[0].message).toBe(payload);
  });

  it('should include idempotencyKey in sessions.send call', async () => {
    await processJob(createFakeJob('{"event":"updated"}', 'job-xyz'), provider);

    expect(receivedSends[0].idempotencyKey).toBe('clawndom:integration-test:job-xyz');
  });

  it('should process multiple jobs sequentially', async () => {
    await processJob(createFakeJob('{"event":"first"}', 'job-1'), provider);
    await processJob(createFakeJob('{"event":"second"}', 'job-2'), provider);

    expect(receivedSends).toHaveLength(2);
    expect(receivedSends[0].message).toBe('{"event":"first"}');
    expect(receivedSends[1].message).toBe('{"event":"second"}');
  });
});
