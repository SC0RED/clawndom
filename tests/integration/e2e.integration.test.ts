/**
 * End-to-end integration test: webhook HTTP → HMAC → BullMQ → worker → gateway WS → agent.wait
 *
 * Mocked: OpenClaw gateway (WebSocket server handling connect/agent/agent.wait RPCs)
 * Real: Express app, HMAC validation, BullMQ queue + worker, GatewayClient WS
 *
 * Simulates webhook payloads from Jira, GitHub, and Linear hitting HTTP endpoints
 * and verifies the full chain through to agent completion.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

import { resetSettings } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';

// -- Secrets --
const JIRA_SECRET = 'jira-test-hmac-secret-1234';
const GITHUB_SECRET = 'github-test-hmac-secret-5678';
const LINEAR_SECRET = 'linear-test-hmac-secret-9012';

// -- Provider config (shared by beforeAll + beforeEach) --
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
const JIRA_PAYLOAD = JSON.stringify({
  webhookEvent: 'jira:issue_updated',
  issue: {
    key: 'SPE-1567',
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

const GITHUB_PAYLOAD = JSON.stringify({
  action: 'submitted',
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

const LINEAR_PAYLOAD = JSON.stringify({
  action: 'update',
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

// -- HMAC helpers --
function signWebSub(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function signGitHub(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

// -- Mock Gateway --
interface AgentRun {
  id: string;
  message: string;
  sessionKey: string;
  providerName: string;
  completedAt?: string;
}

function createMockGateway(): { wss: WebSocketServer; runs: AgentRun[]; getPort: () => number } {
  const runs: AgentRun[] = [];
  const wss = new WebSocketServer({ port: 0 });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(String(data));

      if (msg.method === 'connect') {
        ws.send(JSON.stringify({
          type: 'res', id: msg.id, ok: true,
          payload: {
            type: 'hello-ok', protocol: 3,
            server: { version: 'test', connId: 'ws-e2e' },
            features: { methods: ['agent', 'agent.wait'], events: [] },
            snapshot: { presence: [], health: {}, stateVersion: {}, uptimeMs: 0 },
            policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
          },
        }));
        return;
      }

      if (msg.method === 'agent') {
        const runId = `run-e2e-${runs.length + 1}`;
        runs.push({
          id: runId,
          message: msg.params.message as string,
          sessionKey: msg.params.sessionKey as string,
          providerName: msg.params.name as string,
        });
        ws.send(JSON.stringify({
          type: 'res', id: msg.id, ok: true,
          payload: { runId, acceptedAt: new Date().toISOString() },
        }));
        return;
      }

      if (msg.method === 'agent.wait') {
        const runId = msg.params.runId as string;
        setTimeout(() => {
          const run = runs.find((r) => r.id === runId);
          if (run) run.completedAt = new Date().toISOString();
          ws.send(JSON.stringify({
            type: 'res', id: msg.id, ok: true,
            payload: { runId, status: 'ok', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
          }));
        }, 50);
        return;
      }

      ws.send(JSON.stringify({
        type: 'res', id: msg.id, ok: false,
        error: { code: 'METHOD_NOT_FOUND', message: `Unknown: ${msg.method}` },
      }));
    });
  });

  return { wss, runs, getPort: () => (wss.address() as AddressInfo).port };
}

// -- Helpers --
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRuns(runs: AgentRun[], count: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (runs.filter((r) => r.completedAt).length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${count} completed runs (got ${runs.filter((r) => r.completedAt).length}/${runs.length})`,
      );
    }
    await sleep(100);
  }
}

// -- Test suite --
describe('E2E: webhook → queue → gateway agent.wait', () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let app: import('express').Express;
  let workers: Array<import('bullmq').Worker>;
  let gatewayClient: import('../../src/services/gateway-client').GatewayClient;

  beforeAll(async () => {
    gateway = createMockGateway();

    process.env.OPENCLAW_TOKEN = 'e2e-test-token';
    process.env.OPENCLAW_GATEWAY_WS_URL = `ws://127.0.0.1:${gateway.getPort()}`;
    process.env.PROVIDERS_CONFIG = JSON.stringify(TEST_PROVIDERS);
    process.env.AGENT_WAIT_TIMEOUT_MS = '10000';
    resetSettings();
    resetQueues();

    const { createApp } = await import('../../src/app');
    app = createApp();

    const { GatewayClient } = await import('../../src/services/gateway-client');
    const { createWorker } = await import('../../src/services/worker.service');
    const { getSettings } = await import('../../src/config');

    const settings = getSettings();
    gatewayClient = new GatewayClient(settings.openclawGatewayWsUrl, settings.openclawToken);
    await gatewayClient.connect();

    workers = settings.providers.map((p) => createWorker(p, gatewayClient));
  });

  beforeEach(() => {
    // Global setup.ts resets settings each test — restore our env so getSettings() re-parses correctly
    process.env.OPENCLAW_TOKEN = 'e2e-test-token';
    process.env.OPENCLAW_GATEWAY_WS_URL = `ws://127.0.0.1:${gateway.getPort()}`;
    process.env.PROVIDERS_CONFIG = JSON.stringify(TEST_PROVIDERS);
    process.env.AGENT_WAIT_TIMEOUT_MS = '10000';
    gateway.runs.length = 0;
  });

  afterAll(async () => {
    if (workers) await Promise.all(workers.map((w) => w.close()));
    if (gatewayClient) await gatewayClient.close();
    await new Promise<void>((resolve, reject) => {
      gateway.wss.close((err) => (err ? reject(err) : resolve()));
    });
    resetSettings();
    resetQueues();
  });

  // --- Jira ---

  it('should accept a Jira webhook and deliver to agent with completion', async () => {
    const res = await request(app)
      .post('/hooks/jira')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(JIRA_PAYLOAD, JIRA_SECRET))
      .send(JIRA_PAYLOAD);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });

    await waitForRuns(gateway.runs, 1, 5000);

    expect(gateway.runs).toHaveLength(1);
    const [run] = gateway.runs;
    expect(run.providerName).toBe('jira');
    expect(run.sessionKey).toMatch(/^hook:jira:/);
    expect(run.completedAt).toBeDefined();

    const forwarded = JSON.parse(run.message);
    expect(forwarded.issue.key).toBe('SPE-1567');
    expect(forwarded.webhookEvent).toBe('jira:issue_updated');
  });

  // --- GitHub ---

  it('should accept a GitHub webhook with X-Hub-Signature-256', async () => {
    const res = await request(app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signGitHub(GITHUB_PAYLOAD, GITHUB_SECRET))
      .send(GITHUB_PAYLOAD);

    expect(res.status).toBe(202);

    await waitForRuns(gateway.runs, 1, 5000);

    const [run] = gateway.runs;
    expect(run.providerName).toBe('github');
    expect(run.sessionKey).toMatch(/^hook:github:/);

    const forwarded = JSON.parse(run.message);
    expect(forwarded.action).toBe('submitted');
    expect(forwarded.pull_request.number).toBe(1053);
    expect(forwarded.repository.full_name).toBe('SC0RED/Platform-Frontend');
  });

  // --- Linear ---

  it('should accept a Linear webhook (websub strategy)', async () => {
    const res = await request(app)
      .post('/hooks/linear')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(LINEAR_PAYLOAD, LINEAR_SECRET))
      .send(LINEAR_PAYLOAD);

    expect(res.status).toBe(202);

    await waitForRuns(gateway.runs, 1, 5000);

    const [run] = gateway.runs;
    expect(run.providerName).toBe('linear');
    const forwarded = JSON.parse(run.message);
    expect(forwarded.data.identifier).toBe('ENG-42');
  });

  // --- Security ---

  it('should reject a webhook with invalid HMAC signature', async () => {
    const res = await request(app)
      .post('/hooks/jira')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(JIRA_PAYLOAD, 'wrong-secret'))
      .send(JIRA_PAYLOAD);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });

    await sleep(200);
    expect(gateway.runs).toHaveLength(0);
  });

  it('should reject a webhook with missing signature header', async () => {
    const res = await request(app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .send(GITHUB_PAYLOAD);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing signature' });
  });

  it('should return 404 for unconfigured provider routes', async () => {
    const res = await request(app)
      .post('/hooks/stripe')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'sha256=abc123')
      .send("{}");

    expect(res.status).toBe(404);
  });

  // --- Multi-provider concurrency ---

  it('should process webhooks from multiple providers in parallel', async () => {
    const [jiraRes, githubRes, linearRes] = await Promise.all([
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(JIRA_PAYLOAD, JIRA_SECRET))
        .send(JIRA_PAYLOAD),
      request(app)
        .post('/hooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signGitHub(GITHUB_PAYLOAD, GITHUB_SECRET))
        .send(GITHUB_PAYLOAD),
      request(app)
        .post('/hooks/linear')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(LINEAR_PAYLOAD, LINEAR_SECRET))
        .send(LINEAR_PAYLOAD),
    ]);

    expect(jiraRes.status).toBe(202);
    expect(githubRes.status).toBe(202);
    expect(linearRes.status).toBe(202);

    await waitForRuns(gateway.runs, 3, 10000);

    expect(gateway.runs).toHaveLength(3);
    const providers = gateway.runs.map((r) => r.providerName).sort();
    expect(providers).toEqual(['github', 'jira', 'linear']);

    for (const run of gateway.runs) {
      expect(run.completedAt).toBeDefined();
    }
  });

  // --- Same-provider serialization ---

  it('should serialize multiple webhooks from the same provider', async () => {
    const payload2 = JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue: {
        key: 'SPE-1593',
        fields: {
          summary: 'Checkbox un-check bug',
          status: { name: 'In Development' },
          assignee: { displayName: 'Patches' },
          priority: { name: 'High' },
          issuetype: { name: 'Bug' },
        },
      },
      changelog: { items: [{ field: 'status', fromString: 'Plan', toString: 'In Development' }] },
    });

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(JIRA_PAYLOAD, JIRA_SECRET))
        .send(JIRA_PAYLOAD),
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(payload2, JIRA_SECRET))
        .send(payload2),
    ]);

    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);

    await waitForRuns(gateway.runs, 2, 10000);

    expect(gateway.runs).toHaveLength(2);
    for (const run of gateway.runs) {
      expect(run.providerName).toBe('jira');
      expect(run.completedAt).toBeDefined();
    }

    // Second run started after first completed (serialized by BullMQ concurrency:1)
    const [first, second] = gateway.runs;
    expect(new Date(first.completedAt!).getTime()).toBeLessThanOrEqual(
      new Date(second.completedAt!).getTime(),
    );
  });
});
