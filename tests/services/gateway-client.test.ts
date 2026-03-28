import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import { GatewayClient } from '../../src/services/gateway-client';

describe('GatewayClient', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeAll(async () => {
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
        } else if (msg.method === 'agent') {
          ws.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-test-1', acceptedAt: new Date().toISOString() },
            }),
          );
        } else if (msg.method === 'agent.wait') {
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
        }
      });
    });

    port = (wss.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('should connect and complete handshake', async () => {
    const client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await expect(client.connect()).resolves.toBeUndefined();
    await client.close();
  });

  it('should run agent and wait for completion', async () => {
    const client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await client.connect();

    const result = await client.runAndWait({ message: 'test payload', name: 'test' }, 30_000);

    expect(result.runId).toBe('run-test-1');
    expect(result.status).toBe('ok');

    await client.close();
  });

  it('should reject when connect fails', async () => {
    const client = new GatewayClient('ws://127.0.0.1:1', 'bad-token');
    await expect(client.connect()).rejects.toThrow();
  });

  it('should reuse existing connection', async () => {
    const client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await client.connect();
    await client.connect(); // should not throw or create new connection

    const result = await client.runAndWait({ message: 'reuse test' }, 30_000);
    expect(result.status).toBe('ok');

    await client.close();
  });
});
