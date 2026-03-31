/**
 * End-to-end integration test: webhook HTTP → HMAC → BullMQ → worker → gateway (sendToSession)
 *
 * Mocked: gateway-client.service (sendToSession) — captures deliveries synchronously, no WS or subprocess
 * Real: Express app, HMAC validation, BullMQ queue + worker
 *
 * Simulates webhook payloads from Jira, GitHub, and Linear hitting HTTP endpoints
 * and verifies the full chain through to gateway delivery.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';

import { vi } from 'vitest';
import { resetSettings } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';

// -- Delivery capture --
interface DeliveredPayload {
  message: string;
  sessionKey: string;
  idempotencyKey?: string;
  receivedAt: string;
}

/**
 * Per-test deliveries array. Reset in beforeEach so each test sees only its own deliveries.
 * The mock implementation is rebuilt in beforeEach to close over the current array reference.
 */
let testDeliveries: DeliveredPayload[] = [];

const { mockSendToSession } = vi.hoisted(() => ({
  mockSendToSession: vi.fn(),
}));

vi.mock('../../src/services/gateway-client.service', () => ({
  sendToSession: mockSendToSession,
}));

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
// Unique nonce per call defeats content-hash dedup across tests in the same suite run
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

// -- Polling helper --
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDeliveries(
  deliveries: DeliveredPayload[],
  count: number,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (deliveries.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} deliveries (got ${deliveries.length})`);
    }
    await sleep(50);
  }
}

// -- Test suite --
describe('E2E: webhook → queue → gateway delivery (sendToSession mock)', () => {
  let app: import('express').Express;
  let workers: Array<import('bullmq').Worker>;

  beforeAll(async () => {
    process.env.OPENCLAW_TOKEN = 'e2e-test-token';
    process.env.OPENCLAW_AGENT_ID = 'patch';
    process.env.PROVIDERS_CONFIG = JSON.stringify(TEST_PROVIDERS);
    resetSettings();
    resetQueues();

    // Flush stale jobs from previous runs to prevent content-hash dedup false positives
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

    // Allow workers to start and drain any background jobs
    await sleep(500);
    testDeliveries.length = 0;
    mockSendToSession.mockClear();
  });

  beforeEach(async () => {
    // Re-apply env vars and reset settings AFTER global beforeEach (which calls resetSettings())
    process.env.OPENCLAW_TOKEN = 'e2e-test-token';
    process.env.OPENCLAW_AGENT_ID = 'patch';
    process.env.PROVIDERS_CONFIG = JSON.stringify(TEST_PROVIDERS);
    const { resetSettings: rs } = await import('../../src/config');
    rs();

    // Fresh per-test delivery array — closes over by the mock implementation
    testDeliveries = [];
    mockSendToSession.mockReset();
    mockSendToSession.mockImplementation(
      (params: { key: string; message: string; idempotencyKey?: string }) => {
        testDeliveries.push({
          message: params.message,
          sessionKey: params.key,
          idempotencyKey: params.idempotencyKey,
          receivedAt: new Date().toISOString(),
        });
        return Promise.resolve({ runId: 'mock-run', status: 'started' });
      },
    );

    // Flush queue to prevent dedup collisions between tests; wait for drain to settle
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const conn = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    for (const p of TEST_PROVIDERS) {
      const q = new Queue(`webhooks-${p.name}`, { connection: conn });
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
    // Wait for any in-flight worker callbacks from prior tests to fire and be discarded
    await sleep(1000);
    testDeliveries = [];
    mockSendToSession.mockReset();
    mockSendToSession.mockImplementation(
      (params: { key: string; message: string; idempotencyKey?: string }) => {
        testDeliveries.push({
          message: params.message,
          sessionKey: params.key,
          idempotencyKey: params.idempotencyKey,
          receivedAt: new Date().toISOString(),
        });
        return Promise.resolve({ runId: 'mock-run', status: 'started' });
      },
    );
  });

  afterAll(async () => {
    if (workers) await Promise.all(workers.map((w) => w.close()));
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

    await waitForDeliveries(testDeliveries, 1, 8000);

    expect(testDeliveries).toHaveLength(1);
    const [delivery] = testDeliveries;
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

    await waitForDeliveries(testDeliveries, 1, 5000);

    const forwarded = JSON.parse(testDeliveries[0].message);
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

    await waitForDeliveries(testDeliveries, 1, 5000);

    const forwarded = JSON.parse(testDeliveries[0].message);
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
    expect(testDeliveries).toHaveLength(0);
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

  it('should process webhooks from multiple providers', { timeout: 30_000 }, async () => {
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

    await waitForDeliveries(testDeliveries, 3, 20000);
    expect(testDeliveries).toHaveLength(3);
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

    await waitForDeliveries(testDeliveries, 2, 8000);

    expect(testDeliveries).toHaveLength(2);
    const keys1 = JSON.parse(testDeliveries[0].message).issue.key;
    const keys2 = JSON.parse(testDeliveries[1].message).issue.key;
    expect([keys1, keys2].sort()).toEqual(['SPE-1567', 'SPE-1593']);

    // Verify sequential ordering within the same provider queue
    const t1 = new Date(testDeliveries[0].receivedAt).getTime();
    const t2 = new Date(testDeliveries[1].receivedAt).getTime();
    expect(t1).toBeLessThanOrEqual(t2);
  });
});
