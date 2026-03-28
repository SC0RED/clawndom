import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Job } from 'bullmq';
import type { AddressInfo } from 'node:net';

import type { ProviderConfig } from '../../src/config';
import { GatewayClient } from '../../src/services/gateway-client';

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

describe('Worker integration (gateway WS)', () => {
  let wss: WebSocketServer;
  let gatewayClient: GatewayClient;
  let receivedRpcs: Array<{ method: string; params: Record<string, unknown> }>;

  beforeAll(async () => {
    receivedRpcs = [];

    wss = new WebSocketServer({ port: 0 });

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data: Buffer | string) => {
        const msg = JSON.parse(String(data));

        if (msg.method === 'connect') {
          ws.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: {
                type: 'hello-ok',
                protocol: 3,
                server: { version: 'test', connId: 'ws-test' },
                features: { methods: ['agent', 'agent.wait'], events: [] },
                snapshot: { presence: [], health: {}, stateVersion: {}, uptimeMs: 0 },
                policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
              },
            }),
          );
          return;
        }

        receivedRpcs.push({ method: msg.method, params: msg.params });

        if (msg.method === 'agent') {
          ws.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: `run-${msg.id}`, acceptedAt: new Date().toISOString() },
            }),
          );
        } else if (msg.method === 'agent.wait') {
          // Simulate a short agent run
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: 'res',
                id: msg.id,
                ok: true,
                payload: {
                  runId: msg.params.runId,
                  status: 'ok',
                  startedAt: new Date().toISOString(),
                  endedAt: new Date().toISOString(),
                },
              }),
            );
          }, 50);
        }
      });
    });

    const address = wss.address() as AddressInfo;
    gatewayClient = new GatewayClient(`ws://127.0.0.1:${address.port}`, 'test-token');
    await gatewayClient.connect();
  });

  afterEach(() => {
    receivedRpcs = [];
  });

  afterAll(async () => {
    await gatewayClient.close();
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('should send agent RPC with job data and wait for completion', async () => {
    const payload = '{"event":"updated"}';

    await processJob(createFakeJob(payload), provider, gatewayClient);

    expect(receivedRpcs).toHaveLength(2);

    const [agentCall, waitCall] = receivedRpcs;
    expect(agentCall.method).toBe('agent');
    expect(agentCall.params.message).toBe(payload);
    expect(agentCall.params.name).toBe('integration-test');

    expect(waitCall.method).toBe('agent.wait');
    expect(waitCall.params.runId).toMatch(/^run-clawndom-/);
  });

  it('should process multiple jobs sequentially with completion tracking', async () => {
    await processJob(createFakeJob('{"event":"first"}', 'job-1'), provider, gatewayClient);
    await processJob(createFakeJob('{"event":"second"}', 'job-2'), provider, gatewayClient);

    // 2 jobs × 2 RPCs each (agent + agent.wait)
    expect(receivedRpcs).toHaveLength(4);
    expect(receivedRpcs[0].method).toBe('agent');
    expect(receivedRpcs[0].params.message).toBe('{"event":"first"}');
    expect(receivedRpcs[1].method).toBe('agent.wait');
    expect(receivedRpcs[2].method).toBe('agent');
    expect(receivedRpcs[2].params.message).toBe('{"event":"second"}');
    expect(receivedRpcs[3].method).toBe('agent.wait');
  });
});
