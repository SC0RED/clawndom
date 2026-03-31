/**
 * End-to-end integration test: webhook HTTP → HMAC → BullMQ → worker → gateway WS sessions.send
 *
 * Mocked: OpenClaw gateway (WebSocket server accepting sessions.send calls)
 * Real: Express app, HMAC validation, BullMQ queue + worker
 *
 * Simulates webhook payloads from Jira, GitHub, and Linear hitting HTTP endpoints
 * and verifies the full chain through to gateway WS delivery.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import request from 'supertest';

import { vi } from 'vitest';
import { resetSettings } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';

// -- Secrets --
const JIRA_SECRET = 'jira-test-hmac-secret-1234';
const GITHUB_SECRET = 'github-test-hmac-secret-5678';
const LINEAR_SECRET = 'linear-test-hmac-secret-9012';

// -- Provider config --
const TEST_PROVIDERS = [
  {
    name: 'jira',
    routePath: '/hooks/jira',
    hmacSecret: JIRA_SECRET,
    signatureStrategy: 'websub',
    openclawHookUrl: 'http://unused',
  },
  {
    name: 'github',
    routePath: '/hooks/github',
    hmacSecret: GITHUB_SECRET,
    signatureStrategy: 'github',
    openclawHookUrl: 'http://unused',
  },
  {
    name: 'linear',
    routePath: '/hooks/linear',
    hmacSecret: LINEAR_SECRET,
    signatureStrategy: 'websub',
    openclawHookUrl: 'http://unused',
  },
];

// -- Sample payloads --
// Each call gets a unique nonce so content-hash dedup never skips within a suite run
let _nonceCounter = 0;
function nonce(): number {
  return Date.now() * 1000 + ++_nonceCounter;
}

function makeJiraPayload(key = 'SPE-1567'): string {
  return JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    _testNonce: nonce(),
    issue: {
      key,
      fields: {
        summary: 'Scorecard modal needs Done button',
        status: { name: 'Ready for Development' },
        assignee: { displayName: 'Patches' },
        priority: { name: 'Medium' },
        issuetype: { name: 'Bug' },
      },
    },
    changelog: {
      items: [{ field: 'status', fromString: 'Plan Review', toString: 'Ready for Development' }],
    },
  });
}

function makeGithubPayload(): string {
  return JSON.stringify({
    action: 'submitted',
    _testNonce: nonce(),
    review: {
      state: 'changes_requested',
      body: 'Need to handle the edge case when scorecard is empty',
      user: { login: 'scarlett-bot' },
    },
    pull_request: {
      number: 1053,
      title: 'fix(SPE-1567): add Done button to scorecard modal',
      html_url: 'https://github.com/SC0RED/Platform-Frontend/pull/1053',
      head: { ref: 'fix/SPE-1567-scorecard-done-button' },
    },
    repository: { full_name: 'SC0RED/Platform-Frontend' },
  });
}

function makeLinearPayload(): string {
  return JSON.stringify({
    action: 'update',
    _testNonce: nonce(),
    type: 'Issue',
    data: {
      id: 'lin-issue-123',
      identifier: 'ENG-42',
      title: 'Refactor auth middleware',
      state: { name: 'In Progress' },
      assignee: { name: 'Patch' },
    },
    updatedFrom: { stateId: 'state-backlog' },
  });
}

// -- HMAC helpers --
function signWebSub(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function signGitHub(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

// -- Mock Gateway (WebSocket sessions.send) --
interface DeliveredPayload {
  /** The sessions.send `message` field. */
  message: string;
  /** The sessions.send `key` field. */
  sessionKey: string;
  idempotencyKey?: string;
  receivedAt: string;
}

function createMockGateway(token = 'e2e-test-token'): {
  httpServer: Server;
  wss: WebSocketServer;
  deliveries: DeliveredPayload[];
  getPort: () => number;
} {
  const deliveries: DeliveredPayload[] = [];
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
            JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: 401, message: 'unauthorized' } }),
          );
          return;
        }
        ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        return;
      }

      if (frame.method === 'sessions.send') {
        const p = frame.params as { key: string; message: string; idempotencyKey?: string };
        const delivery: DeliveredPayload = {
          message: p.message,
          sessionKey: p.key,
          idempotencyKey: p.idempotencyKey,
          receivedAt: new Date().toISOString(),
        };
        deliveries.push(delivery);
        ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        return;
      }

      ws.send(
        JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: 404, message: `unknown: ${frame.method}` } }),
      );
    });
  });

  httpServer.listen(0);

  return {
    httpServer,
    wss,
    deliveries,
    getPort: () => (httpServer.address() as AddressInfo).port,
  };
}

// -- Helpers --
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDeliveries(
  deliveries: DeliveredPayload[],
  count: number,
  timeoutMs: number = 5000,
): Promise<void> {
  const start = Date.now();
  while (deliveries.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} deliveries (got ${deliveries.length})`);
    }
    await sleep(100);
  }
}

// -- Test suite --
describe('E2E: webhook → queue → gateway WS delivery', () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let app: import('express').Express;
  let workers: Array<import('bullmq').Worker>;

  beforeAll(async () => {
    gateway = createMockGateway('e2e-test-token');

    process.env.OPENCLAW_TOKEN = 'e2e-test-token';
    process.env.OPENCLAW_GATEWAY_WS_URL = `ws://127.0.0.1:${gateway.getPort()}`;
    process.env.PROVIDERS_CONFIG = JSON.stringify(TEST_PROVIDERS);
    resetSettings();
    resetQueues();

    // Flush stale completed/failed jobs from previous runs so content-hash dedup works
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const flushConn = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    for (const p of TEST_PROVIDERS) {
      const q = new Queue(`webhooks-${p.name}`, { connection: flushConn });
      await q.drain(true);
      const completed = await q.getCompleted(0, 1000);
      const failed = await q.getFailed(0, 1000);
      const waiting = await q.getWaiting(0, 1000);
      for (const job of [...completed, ...failed, ...waiting]) {
        await job.remove();
      }
      await q.close();
    }
    await flushConn.quit();

    const { createApp } = await import('../../src/app');
    app = createApp();

    const { createWorker } = await import('../../src/services/worker.service');
    const { getSettings } = await import('../../src/config');

    const settings = getSettings();
    workers = settings.providers.map((p) => createWorker(p));

    // Wait for workers to fully connect and drain any stale jobs before tests run
    await sleep(2000);
    gateway.deliveries.length = 0;
  });

  beforeEach(async () => {
    process.env.OPENCLAW_TOKEN = 'e2e-test-token';
    process.env.OPENCLAW_GATEWAY_WS_URL = `ws://127.0.0.1:${gateway.getPort()}`;
    process.env.OPENCLAW_AGENT_ID = 'patch';
    process.env.PROVIDERS_CONFIG = JSON.stringify(TEST_PROVIDERS);
    // Re-initialize settings AFTER setting env vars (global beforeEach resets them first)
    const { resetSettings: rs } = await import('../../src/config');
    rs();
    gateway.deliveries.length = 0;

    // Remove completed/failed jobs between tests so content-hash dedup doesn't skip re-enqueues
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const conn = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    for (const p of TEST_PROVIDERS) {
      const q = new Queue(`webhooks-${p.name}`, { connection: conn });
      // Drain all job states (waiting, delayed, completed, failed) to prevent dedup skips
      await q.drain(true);
      const completed = await q.getCompleted(0, 1000);
      const failed = await q.getFailed(0, 1000);
      const waiting = await q.getWaiting(0, 1000);
      for (const job of [...completed, ...failed, ...waiting]) {
        await job.remove();
      }
      await q.close();
    }
    await conn.quit();
    // Brief wait for workers to catch up after queue drain
    await sleep(200);
  });

  afterAll(async () => {
    if (workers) await Promise.all(workers.map((w) => w.close()));
    gateway.wss.close();
    await new Promise<void>((resolve, reject) => {
      gateway.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.OPENCLAW_GATEWAY_WS_URL;
    resetSettings();
    resetQueues();
  });

  // --- Jira ---

  it('should accept a Jira webhook and deliver to gateway', { timeout: 15_000 }, async () => {
    const payload = makeJiraPayload();
    const res = await request(app)
      .post('/hooks/jira')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(payload, JIRA_SECRET))
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });

    await waitForDeliveries(gateway.deliveries, 1, 10000);

    expect(gateway.deliveries).toHaveLength(1);
    const [delivery] = gateway.deliveries;
    expect(delivery.sessionKey).toBe('agent:patch:main');

    const forwarded = JSON.parse(delivery.message);
    expect(forwarded.issue.key).toBe('SPE-1567');
    expect(forwarded.webhookEvent).toBe('jira:issue_updated');
  });

  // --- GitHub ---

  it('should accept a GitHub webhook with X-Hub-Signature-256', async () => {
    const payload = makeGithubPayload();
    const res = await request(app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signGitHub(payload, GITHUB_SECRET))
      .send(payload);

    expect(res.status).toBe(202);

    await waitForDeliveries(gateway.deliveries, 1, 5000);

    const forwarded = JSON.parse(gateway.deliveries[0].message);
    expect(forwarded.action).toBe('submitted');
    expect(forwarded.pull_request.number).toBe(1053);
    expect(forwarded.repository.full_name).toBe('SC0RED/Platform-Frontend');
  });

  // --- Linear ---

  it('should accept a Linear webhook (websub strategy)', async () => {
    const payload = makeLinearPayload();
    const res = await request(app)
      .post('/hooks/linear')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(payload, LINEAR_SECRET))
      .send(payload);

    expect(res.status).toBe(202);

    await waitForDeliveries(gateway.deliveries, 1, 5000);

    const forwarded = JSON.parse(gateway.deliveries[0].message);
    expect(forwarded.data.identifier).toBe('ENG-42');
  });

  // --- Security ---

  it('should reject a webhook with invalid HMAC signature', async () => {
    const payload = makeJiraPayload();
    const res = await request(app)
      .post('/hooks/jira')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(payload, 'wrong-secret'))
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });

    await sleep(200);
    expect(gateway.deliveries).toHaveLength(0);
  });

  it('should reject a webhook with missing signature header', async () => {
    const payload = makeGithubPayload();
    const res = await request(app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing signature' });
  });

  it('should return 404 for unconfigured provider routes', async () => {
    const res = await request(app)
      .post('/hooks/stripe')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'sha256=abc123')
      .send('{}');

    expect(res.status).toBe(404);
  });

  // --- Multi-provider ---

  it('should process webhooks from multiple providers', { timeout: 15_000 }, async () => {
    const jiraPayload = makeJiraPayload();
    const githubPayload = makeGithubPayload();
    const linearPayload = makeLinearPayload();

    const [jiraRes, githubRes, linearRes] = await Promise.all([
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(jiraPayload, JIRA_SECRET))
        .send(jiraPayload),
      request(app)
        .post('/hooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signGitHub(githubPayload, GITHUB_SECRET))
        .send(githubPayload),
      request(app)
        .post('/hooks/linear')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(linearPayload, LINEAR_SECRET))
        .send(linearPayload),
    ]);

    expect(jiraRes.status).toBe(202);
    expect(githubRes.status).toBe(202);
    expect(linearRes.status).toBe(202);

    await waitForDeliveries(gateway.deliveries, 3, 10000);
    expect(gateway.deliveries).toHaveLength(3);
  });

  // --- Serialization ---

  it('should serialize multiple webhooks from the same provider', { timeout: 15_000 }, async () => {
    const payload1 = makeJiraPayload('SPE-1567');
    const payload2 = makeJiraPayload('SPE-1593');

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(payload1, JIRA_SECRET))
        .send(payload1),
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(payload2, JIRA_SECRET))
        .send(payload2),
    ]);

    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);

    await waitForDeliveries(gateway.deliveries, 2, 10000);
    expect(gateway.deliveries).toHaveLength(2);

    // Verify ordering — second delivery happened after first
    const [first, second] = gateway.deliveries;
    expect(new Date(first.receivedAt).getTime()).toBeLessThanOrEqual(
      new Date(second.receivedAt).getTime(),
    );
  });
});
