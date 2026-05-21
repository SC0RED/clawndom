import { createHmac } from 'node:crypto';

import supertest from 'supertest';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import { createApp } from '../../src/app';
import { getSettings, resetSettings, providerSchema } from '../../src/config';
import {
  agentConfigSchema,
  mergeProviders,
  type ResolvedAgent,
} from '../../src/services/agent-loader.service';

vi.mock('../../src/services/queue.service', () => ({
  getProviderQueue: vi.fn(() => ({ add: vi.fn().mockResolvedValue({ id: 'test-job' }) })),
}));

const ORIGINAL_PROVIDERS_CONFIG = process.env.PROVIDERS_CONFIG;
const SECRET = 'workspace-provider-secret';

function websubSignature(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
}

/** An agent whose inbound provider is declared ONLY in its workspace config. */
function buildWinston(): ResolvedAgent {
  const provider = providerSchema.parse({
    name: 'practice-intake',
    routePath: '/hooks/practice-intake',
    hmacSecret: SECRET,
    signatureStrategy: 'websub',
  });
  return {
    name: 'winston',
    dir: '/tmp/clawndom-winston-test',
    config: agentConfigSchema.parse({
      providers: [provider],
      routing: { 'practice-intake': { rules: [{ condition: { all_of: [] } }] } },
    }),
  };
}

/** Reproduce startServer's provider wiring with no env providers at all. */
function bootApp(agents: ResolvedAgent[]): ReturnType<typeof createApp> {
  process.env.PROVIDERS_CONFIG = '[]';
  resetSettings();
  const settings = getSettings();
  const merged = mergeProviders(settings.providers, agents, []);
  settings.providers.length = 0;
  settings.providers.push(...merged);
  return createApp(agents);
}

describe('workspace-declared providers (API integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    if (ORIGINAL_PROVIDERS_CONFIG === undefined) delete process.env.PROVIDERS_CONFIG;
    else process.env.PROVIDERS_CONFIG = ORIGINAL_PROVIDERS_CONFIG;
    resetSettings();
  });

  it('mounts an authenticated webhook route from a provider declared only in the workspace', async () => {
    const app = bootApp([buildWinston()]);
    const payload = JSON.stringify({ event: 'new_intake' });

    const response = await supertest(app)
      .post('/hooks/practice-intake')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', websubSignature(payload, SECRET))
      .send(payload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
  });

  it('enforces auth on a workspace-declared provider (bad signature → 401)', async () => {
    const app = bootApp([buildWinston()]);

    const response = await supertest(app)
      .post('/hooks/practice-intake')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'sha256=deadbeef')
      .send(JSON.stringify({ event: 'new_intake' }));

    expect(response.status).toBe(401);
  });
});
